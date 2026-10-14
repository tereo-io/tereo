import { trace } from "@opentelemetry/api";
import {
  ATTR_USER_ID,
  ATTR_USER_ROLES,
} from "@opentelemetry/semantic-conventions/incubating";

export interface AuthAttrsLike {
  userId: string;
  userType: string;
  organizationId?: string | null;
  oauthClientId?: string | null;
}

/**
 * Annotate the active span with caller-identity attributes resolved by the
 * auth middleware. No-op when there's no active span (e.g., service startup
 * code or background paths without an inherited trace context).
 *
 * Identity attributes use OTel's `user.*` namespace (`enduser.role` was
 * deprecated in favor of `user.roles`; `user.id` is the modern home for
 * what used to be `enduser.id`). `userType` (`"human"` / `"service_account"`)
 * is wrapped in a single-element array to fit `user.roles`'s array contract;
 * everything else uses a `tereo.*` vendor prefix so we don't collide
 * with future OTel conventions.
 */
export const setAuthSpanAttrs = (auth: AuthAttrsLike): void => {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute(ATTR_USER_ID, auth.userId);
  span.setAttribute(ATTR_USER_ROLES, [auth.userType]);
  if (auth.organizationId)
    span.setAttribute("tereo.org.id", auth.organizationId);
  if (auth.oauthClientId)
    span.setAttribute("tereo.oauth.client_id", auth.oauthClientId);
};

/**
 * Annotate the active span with the permission required by a route. No-op
 * when there's no active span. Uses a `tereo.*` vendor prefix because
 * OTel has no semantic convention for required-permission today.
 */
export const setRequiredPermission = (permission: string): void => {
  trace.getActiveSpan()?.setAttribute("tereo.permission.required", permission);
};
