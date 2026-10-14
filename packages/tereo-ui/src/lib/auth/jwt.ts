interface AccessTokenPayload {
  sub: string;
  exp: number;
  /** The refresh token the access token was issued with; rotates on refresh. */
  sid?: string;
  org_id?: string;
}

interface IdTokenPayload {
  sub: string;
  aud: string;
  exp: number;
  nonce?: string;
  /** The SSO session (browser) the login belongs to. */
  sid?: string;
}

/** Reads a JWT's claims without verifying it. */
const decodeJWT = <T>(token: string): T | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
};

export const decodeAccessToken = (token: string) =>
  decodeJWT<AccessTokenPayload>(token);

export const decodeIdToken = (token: string) =>
  decodeJWT<IdTokenPayload>(token);
