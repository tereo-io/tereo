import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";

/** The URL search param that holds the organization a webhooks.admin is viewing. */
export const WEBHOOKS_ORG_PARAM = "org";

export interface WebhooksOrganization {
  /** Whether the user may view other organizations' webhooks (`webhooks.admin`). */
  canSwitch: boolean;
  /** The organization requested in the URL, when it isn't the token's own. */
  overrideId: string | null;
  /** The organization whose webhooks are shown. */
  organizationId: string | null;
  /** `?org=…` to carry the choice onto another webhooks page, or "". */
  search: string;
}

/**
 * The organization the webhooks section is scoped to: the token's own, or —
 * for webhooks.admin — the one named in `?org=`, which core receives as
 * `X-Organization-ID` (see `useWebhooksAxios`).
 */
const useWebhooksOrganization = (): WebhooksOrganization => {
  const { hasPermission, currentOrganization } = useAuth();
  const [params] = useSearchParams();

  const canSwitch = hasPermission("webhooks.admin");
  const requested = params.get(WEBHOOKS_ORG_PARAM);
  const ownId = currentOrganization?.id ?? null;

  return useMemo(() => {
    const overrideId =
      canSwitch && requested && requested !== ownId ? requested : null;
    return {
      canSwitch,
      overrideId,
      organizationId: overrideId ?? ownId,
      search: overrideId
        ? `?${new URLSearchParams({ [WEBHOOKS_ORG_PARAM]: overrideId })}`
        : "",
    };
  }, [canSwitch, requested, ownId]);
};

export default useWebhooksOrganization;
