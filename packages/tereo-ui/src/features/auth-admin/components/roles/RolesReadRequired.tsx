import { Alert } from "@kosmeo-ui/react";

/**
 * Role pickers list roles through `GET /v1/admin/roles`, which needs
 * `roles.read` even where core lets the viewer assign them (an
 * organization's admins, for its members and groups).
 */
export const RolesReadRequired = () => (
  <Alert variant="warning">
    Choosing roles needs the <code>roles.read</code> permission to list them.
    Ask an administrator who has it to change these roles.
  </Alert>
);
