import useSetIntegrationRoles from "../../api/useSetIntegrationRoles";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import type { Integration } from "../../api/types";
import { useState } from "react";
import {
  Alert,
  Button,
  CheckboxGroup,
  Col,
  EmptyState,
  Modal,
  Spinner,
} from "@kosmeo-ui/react";

export const GLOBAL_ROLES_WARNING =
  "This integration is not bound to an organization, so the roles you pick here are global roles: they apply in every organization.";

/**
 * Org-bound integrations get custom roles whose permissions are all
 * org-assignable (core refuses anything else); platform ones get any active
 * role, which is global. Roles already held stay listed so saving keeps them.
 */
const EditIntegrationRolesButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const { data: roles, isLoading } = useAllRoles();
  const { mutate, isPending } = useSetIntegrationRoles();

  const orgBound = integration.organizationId !== null;
  const held = new Set(integration.roles.map((r) => r.id));
  const options = (roles ?? []).filter(
    (r) =>
      r.isActive &&
      !r.retiredAt &&
      (held.has(r.id) ||
        (orgBound
          ? !r.isSystem &&
            (r.permissions ?? []).every((p) => p.retired || p.orgAssignable)
          : true))
  );
  const values = selected ?? integration.roles.map((r) => r.id);

  const handleClose = () => {
    setShow(false);
    setSelected(null);
  };

  const handleSave = () => {
    const known = new Set(options.map((r) => r.id));
    mutate(
      {
        id: integration.id,
        roleIds: values.filter((id) => known.has(id)),
      },
      { onSuccess: handleClose }
    );
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Edit Roles
      </Button>
      <Modal
        show={show}
        onClose={handleClose}
        title="Integration Roles"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleClose}
            disabled={isPending}
          >
            Cancel
          </Button>,
          <Button
            key="save"
            onClick={handleSave}
            isLoading={isPending}
            disabled={isPending || isLoading}
          >
            Save Roles
          </Button>,
        ]}
      >
        <Col size="md">
          {orgBound ? (
            <p>
              Roles for <strong>{integration.name}</strong> within{" "}
              {integration.organization?.name ?? "its organization"}. Only
              custom roles whose permissions are all org-assignable can be
              granted.
            </p>
          ) : (
            <Alert variant="warning" heading="Global roles">
              {GLOBAL_ROLES_WARNING}
            </Alert>
          )}
          {isLoading ? (
            <Spinner size="md" />
          ) : options.length === 0 ? (
            <EmptyState>No role can be granted to this integration</EmptyState>
          ) : (
            <CheckboxGroup
              name={`integration-roles-${integration.id}`}
              options={options.map((role) => ({
                value: role.id,
                label: role.displayName,
              }))}
              values={values}
              onChange={setSelected}
            />
          )}
        </Col>
      </Modal>
    </>
  );
};

export default EditIntegrationRolesButton;
