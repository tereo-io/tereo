import { refreshTokenManager } from "./refreshTokenManager";
import { isLocalStorageChangeEvent } from "./types";
import { useLocalStorage } from "@kosmeo-ui/react";
import useRefreshToken from "./useRefreshToken";
import { isLoggedOut } from "./logoutMarker";
import type { StoredTokens } from "./types";
import env from "./config";
import {
  AxiosContext,
  type ServiceConfig,
  type ServiceKey,
} from "./axiosContextValue";
import {
  useContext,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import axiosBase, {
  type AxiosInstance,
  type AxiosError,
  type InternalAxiosRequestConfig,
} from "axios";

interface AxiosProviderProps {
  services: ServiceConfig;
  children: ReactNode;
}

// After an explicit sign-out the indicator is ignored until the next
// interactive login: it (and the refresh cookie) can outlive a failed revoke.
const hasSessionIndicator = (): boolean =>
  !isLoggedOut() &&
  document.cookie
    .split("; ")
    .some((cookie) => cookie.startsWith(`tsi_${env.CLIENT_ID}=`));

function attachAuthInterceptors(
  instance: AxiosInstance,
  tokensRef: RefObject<StoredTokens | null>,
  refreshTokenRef: RefObject<() => Promise<StoredTokens>>,
  setTokens: (value: StoredTokens | null) => void
) {
  const isTokenExpired = (): boolean => {
    const currentTokens = tokensRef.current;
    if (!currentTokens) return true;
    return Date.now() > currentTokens.expiresAt - env.tokenExpirationBuffer;
  };

  const applyAuthHeaders = (
    config: InternalAxiosRequestConfig,
    accessToken: string
  ): void => {
    config.headers.Authorization = `Bearer ${accessToken}`;
  };

  instance.interceptors.request.use(async (config) => {
    if (isTokenExpired() && hasSessionIndicator()) {
      // A failed refresh fails the request; useRefreshToken clears the
      // tokens if core rejected it.
      const newTokens = await refreshTokenManager.refresh(
        refreshTokenRef.current
      );
      applyAuthHeaders(config, newTokens.access_token);
      return config;
    }

    const currentTokens = tokensRef.current;
    if (currentTokens?.access_token) {
      applyAuthHeaders(config, currentTokens.access_token);
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as InternalAxiosRequestConfig & {
        _retry?: boolean;
      };

      if (error.response?.status !== 401 || originalRequest._retry) {
        return Promise.reject(error);
      }

      if (!hasSessionIndicator()) {
        setTokens(null);
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      const newTokens = await refreshTokenManager.refresh(
        refreshTokenRef.current
      );
      originalRequest.headers.Authorization = `Bearer ${newTokens.access_token}`;
      return instance(originalRequest);
    }
  );
}

export const AxiosProvider = ({ services, children }: AxiosProviderProps) => {
  const [tokens, setTokens] = useLocalStorage<StoredTokens>(env.TOKEN_KEY);
  const tokensRef = useRef(tokens);

  // useRefreshToken must not depend on this provider's context — see note
  // in useRefreshToken.ts.
  const { mutateAsync } = useRefreshToken();
  const refreshTokenRef = useRef(mutateAsync);

  useEffect(() => {
    tokensRef.current = tokens;
    if (!tokens && hasSessionIndicator()) {
      // useRefreshToken logs the failure and clears what core rejected.
      refreshTokenManager.refresh(refreshTokenRef.current).catch(() => {});
    }
  }, [tokens]);

  useEffect(() => {
    refreshTokenRef.current = mutateAsync;
  }, [mutateAsync]);

  useEffect(() => {
    const handleStorageChange = (e: Event) => {
      if (isLocalStorageChangeEvent<StoredTokens>(e)) {
        if (e.detail.key === env.TOKEN_KEY) {
          tokensRef.current = e.detail.value;
        }
      }
    };

    window.addEventListener("localStorageChange", handleStorageChange);
    return () => {
      window.removeEventListener("localStorageChange", handleStorageChange);
    };
  }, []);

  const { instances, baseInstances } = useMemo(() => {
    const authenticated = {} as Record<ServiceKey, AxiosInstance>;
    const base = {} as Record<ServiceKey, AxiosInstance>;
    for (const [key, baseURL] of Object.entries(services)) {
      const instance = axiosBase.create({ baseURL });
      attachAuthInterceptors(instance, tokensRef, refreshTokenRef, setTokens);
      authenticated[key as ServiceKey] = instance;
      base[key as ServiceKey] = axiosBase.create({ baseURL });
    }
    return { instances: authenticated, baseInstances: base };
  }, [env.AUTH_SERVER_URL, env.tokenExpirationBuffer, setTokens]);

  const value = useMemo(
    () => ({ instances, baseInstances }),
    [instances, baseInstances]
  );

  return (
    <AxiosContext.Provider value={value}>{children}</AxiosContext.Provider>
  );
};

/**
 * Hook to access a pre-configured Axios instance for a specific service.
 *
 * The instance sends the access token, refreshing it (one refresh at a time,
 * across tabs) when it is about to expire or a request gets a 401.
 *
 * Must be used within an `<AxiosProvider>` component.
 *
 * @param service - The service key to select which backend to target.
 * @returns Pre-configured Axios instance with automatic token management
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const authAxios = useAxios('auth');
 *   const fileServiceAxios = useAxios('fileService');
 * }
 * ```
 */
export const useAxios = (service: ServiceKey): AxiosInstance => {
  const context = useContext(AxiosContext);
  if (!context) {
    throw new Error("useAxios must be used within an AxiosProvider");
  }
  return context.instances[service];
};

/**
 * Hook to access an unauthenticated Axios instance for a specific service.
 *
 * Returns a plain Axios instance with only the `baseURL` set — no token
 * injection, no 401 retry, no refresh logic. Use for endpoints that rely
 * on session cookies or require no authentication (login, consent, TOTP,
 * token revocation, etc.).
 *
 * Must be used within an `<AxiosProvider>` component.
 *
 * @param service - The service key to select which backend to target.
 * @returns Plain Axios instance with baseURL only
 *
 * @example
 * ```tsx
 * function LoginForm() {
 *   const axios = usePublicAxios('auth');
 *   // No Bearer token injected — uses session cookies instead
 *   await axios.post('/oauth/authorize', data, { withCredentials: true });
 * }
 * ```
 */
export const usePublicAxios = (service: ServiceKey): AxiosInstance => {
  const context = useContext(AxiosContext);
  if (!context) {
    throw new Error("usePublicAxios must be used within an AxiosProvider");
  }
  return context.baseInstances[service];
};
