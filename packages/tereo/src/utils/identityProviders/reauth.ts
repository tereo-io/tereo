import type { NormalizedIdentity, UpstreamReauth } from "./types.js";
import { hasPrompt } from "../../routes/oauth/authorize/schemas.js";

// The provider's clock against core's.
const CLOCK_SKEW_MS = 30_000;

/** What a core authorize request demands of the login it sends upstream. */
export const upstreamReauth = (request: {
  prompt: string | null;
  maxAge: number | null;
}): UpstreamReauth => ({
  // max_age=0 means prompt=login (OIDC Core 3.1.2.1); sent as both, it binds
  // a provider that ignores max_age and leaves out auth_time too.
  promptLogin: hasPrompt(request.prompt, "login") || request.maxAge === 0,
  maxAge: request.maxAge,
});

/**
 * Core's `auth_time` for a provider login: the provider's own, so a silent
 * sign-in on an old session there does not pass for a fresh one. Null when
 * the login does not meet `reauth`: an `auth_time` older than `max_age`
 * allows, or from before the round trip under `prompt=login`, both counted
 * from `startedAt`; or none at all under `max_age` alone. Under
 * `prompt=login` a provider that sends none is taken to have asked.
 */
export const upstreamAuthTime = (
  identity: NormalizedIdentity,
  reauth: UpstreamReauth,
  startedAt: Date,
  now = new Date()
): Date | null => {
  const { authTime } = identity;
  if (authTime === null) {
    return reauth.maxAge !== null && !reauth.promptLogin ? null : now;
  }
  const oldest = Math.max(
    reauth.maxAge === null
      ? -Infinity
      : startedAt.getTime() - reauth.maxAge * 1000,
    reauth.promptLogin ? startedAt.getTime() : -Infinity
  );
  if (authTime.getTime() < oldest - CLOCK_SKEW_MS) return null;
  return authTime > now ? now : authTime;
};
