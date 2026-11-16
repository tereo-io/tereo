import { readTokens, writeTokens } from "./tokens.js";
import { refreshTokens } from "./refresh.js";
import { activeConfig } from "./config.js";
import { hasSession } from "./markers.js";
import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

type Retryable = InternalAxiosRequestConfig & { _retry?: boolean };

const bearer = (config: InternalAxiosRequestConfig, accessToken: string) => {
  config.headers.Authorization = `Bearer ${accessToken}`;
};

const attachAuth = (instance: AxiosInstance): void => {
  instance.interceptors.request.use(async (config) => {
    const tokens = readTokens();
    const nearExpiry =
      !tokens ||
      Date.now() > tokens.expiresAt - activeConfig().tokenExpirationBuffer;

    // A failed refresh fails the request; refreshTokens clears the tokens
    // when core rejected it.
    if (nearExpiry && hasSession()) {
      bearer(config, (await refreshTokens()).access_token);
    } else if (tokens) {
      bearer(config, tokens.access_token);
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const original = error.config as Retryable | undefined;
      if (error.response?.status !== 401 || !original || original._retry) {
        throw error;
      }

      if (!hasSession()) {
        writeTokens(null);
        throw error;
      }

      original._retry = true;
      const tokens = await refreshTokens();
      bearer(original, tokens.access_token);
      return instance(original);
    }
  );
};

/**
 * One client per named API. `authed` sends the access token, renewing it
 * before it expires and once after a 401; `open` sends nothing, for
 * endpoints that need no token or use cookies.
 */
export const createApiClients = (
  apis: Record<string, string>
): {
  authed: Record<string, AxiosInstance>;
  open: Record<string, AxiosInstance>;
} => {
  const authed: Record<string, AxiosInstance> = {};
  const open: Record<string, AxiosInstance> = {};
  for (const [name, baseURL] of Object.entries(apis)) {
    const instance = axios.create({ baseURL });
    attachAuth(instance);
    authed[name] = instance;
    open[name] = axios.create({ baseURL });
  }
  return { authed, open };
};
