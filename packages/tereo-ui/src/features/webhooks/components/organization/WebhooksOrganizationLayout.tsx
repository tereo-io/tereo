import useOrganizationChoices from "../../api/organizations/useOrganizationChoices";
import { Outlet, useNavigate } from "react-router-dom";
import { Alert, Select } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";
import "../styles.css";
import useWebhooksOrganization, {
  WEBHOOKS_ORG_PARAM,
} from "../../hooks/useWebhooksOrganization";

/**
 * Wraps the organization-scoped webhooks pages. For webhooks.admin it adds a
 * switcher that keeps the chosen organization in `?org=`.
 */
export const WebhooksOrganizationLayout = () => (
  <>
    <WebhooksOrganizationSwitcher />
    <Outlet />
  </>
);

const WebhooksOrganizationSwitcher = () => {
  const navigate = useNavigate();
  const { currentOrganization } = useAuth();
  const { canSwitch, overrideId, organizationId } = useWebhooksOrganization();
  const { choices } = useOrganizationChoices();

  const options = useMemo(() => {
    const list = choices.map(({ id, name }) => ({ value: id, label: name }));
    // Select falls back to its first option when the value is missing, which
    // would switch organization on its own: keep the viewed one listed.
    if (organizationId && !list.some((o) => o.value === organizationId)) {
      list.unshift({ value: organizationId, label: organizationId });
    }
    return list;
  }, [choices, organizationId]);

  if (!canSwitch) return null;

  const viewedName =
    options.find((o) => o.value === organizationId)?.label ?? organizationId;

  const switchTo = (id: string | undefined) => {
    if (!id || id === organizationId) return;
    const search =
      id === currentOrganization?.id
        ? ""
        : `?${new URLSearchParams({ [WEBHOOKS_ORG_PARAM]: id })}`;
    navigate({ pathname: "/webhooks/endpoints", search });
  };

  return (
    <div className="t-webhook-org-bar">
      <div className="t-webhook-org-select">
        <Select
          label="Organization"
          size="sm"
          value={organizationId ?? undefined}
          placeholder={organizationId ? undefined : "Choose an organization"}
          options={options}
          onChange={switchTo}
        />
      </div>
      {overrideId && (
        <Alert variant="warning" size="sm">
          Viewing the webhooks of <strong>{viewedName}</strong>, not your
          current organization
          {currentOrganization ? ` (${currentOrganization.name})` : ""}.
        </Alert>
      )}
    </div>
  );
};
