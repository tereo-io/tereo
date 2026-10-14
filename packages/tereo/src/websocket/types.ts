import type { Socket } from "socket.io";

/** The access token a socket connected with; the socket lives as long as it. */
export interface AuthenticatedSocketData {
  userId: string;
  email: string;
  jti: string;
  /** The session (refresh token) the token was issued with, if any. */
  sid: string | null;
  /** The token's `exp`, in seconds. */
  exp: number;
  /** The organization the token was issued for, if any. */
  orgId: string | null;
  /** The client the token was issued to. */
  clientId: string;
}

export type AuthenticatedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  AuthenticatedSocketData
>;

export interface PermissionChangePayload {
  reason:
    | "user_roles_changed"
    | "role_permissions_changed"
    | "role_status_changed"
    | "role_deleted";
  timestamp: number;
}

export interface SessionRevokedPayload {
  sessionId: string;
  timestamp: number;
}

export interface OrganizationChangePayload {
  reason: "membership_changed" | "roles_changed" | "org_deactivated";
  organizationId: string;
  timestamp: number;
}

export interface ServerToClientEvents {
  "auth:permissions:changed": (payload: PermissionChangePayload) => void;
  "auth:session:revoked": (payload: SessionRevokedPayload) => void;
  "auth:organization:changed": (payload: OrganizationChangePayload) => void;
  "auth:pong": (payload: { timestamp: number }) => void;
}

export interface ClientToServerEvents {
  "auth:ping": () => void;
}
