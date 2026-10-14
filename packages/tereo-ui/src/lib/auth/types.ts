export interface StoredTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  expiresAt: number;
}

export interface PermissionChangePayload {
  reason: string;
  timestamp: number;
}

export interface SessionRevokedPayload {
  sessionId: string;
  timestamp: number;
}

/**
 * Custom event dispatched by useLocalStorage hook when localStorage changes.
 * This interface matches the CustomEvent dispatched by @kosmeo-ui/react/useLocalStorage
 */
export interface LocalStorageChangeEvent<T = unknown> extends CustomEvent {
  detail: {
    key: string;
    value: T | null;
  };
}

/**
 * Type guard to check if an event is a LocalStorageChangeEvent
 */
export function isLocalStorageChangeEvent<T = unknown>(
  event: Event
): event is LocalStorageChangeEvent<T> {
  return (
    event instanceof CustomEvent &&
    event.type === "localStorageChange" &&
    typeof (event as CustomEvent).detail === "object" &&
    (event as CustomEvent).detail !== null &&
    "key" in (event as CustomEvent).detail &&
    "value" in (event as CustomEvent).detail
  );
}
