import useSetRolePermissions from "@/features/auth-admin/api/roles/useSetRolePermissions";
import useAllPermissions from "@/features/auth-admin/api/permissions/useAllPermissions";
import { Permission } from "@/features/auth-admin/api/permissions/types";
import { RolePermission } from "@/features/auth-admin/api/roles/types";
import { useState, useImperativeHandle, forwardRef } from "react";
import { Button, Checkbox, Spinner } from "@kosmeo-ui/react";
import "./styles.css";

export interface RolePermissionsEditorRef {
  save: () => void;
}

interface RolePermissionsEditorProps {
  roleId: string;
  currentPermissions: RolePermission[];
  onSuccess: () => void;
}

export const RolePermissionsEditor = forwardRef<
  RolePermissionsEditorRef,
  RolePermissionsEditorProps
>(({ roleId, currentPermissions, onSuccess }, ref) => {
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>(
    currentPermissions.map((p) => p.id)
  );

  const { data, isLoading } = useAllPermissions();
  const mutation = useSetRolePermissions();

  const retiredPermissions = currentPermissions.filter((p) => p.retired);

  const handleTogglePermission = (permissionId: string) => {
    setSelectedPermissionIds((prev) =>
      prev.includes(permissionId)
        ? prev.filter((id) => id !== permissionId)
        : [...prev, permissionId]
    );
  };

  const handleSelectAll = () => {
    // Retired permissions stay only if already selected — core refuses to add
    // one, but lets a custom role keep it.
    setSelectedPermissionIds((prev) => [
      ...retiredPermissions.filter((p) => prev.includes(p.id)).map((p) => p.id),
      ...(data ?? []).map((p) => p.id),
    ]);
  };

  const handleClearAll = () => {
    setSelectedPermissionIds([]);
  };

  useImperativeHandle(ref, () => ({
    save: () => {
      mutation.mutate(
        { roleId, permissionIds: selectedPermissionIds },
        { onSuccess }
      );
    },
  }));

  if (isLoading) {
    return (
      <div className="t-permissions-editor-loading">
        <Spinner size="md" />
      </div>
    );
  }

  // `useAllPermissions` returns only unretired permissions, so they are the
  // assignable set; core groups names by their declaring service's namespace
  // (e.g. "users", "roles", "file-service").
  const groupedPermissions = (data ?? []).reduce(
    (acc, permission) => {
      const prefix = permission.name.split(".")[0];
      if (!acc[prefix]) acc[prefix] = [];
      acc[prefix].push(permission);
      return acc;
    },
    {} as Record<string, Pick<Permission, "id" | "name" | "displayName">[]>
  );
  if (retiredPermissions.length > 0) {
    groupedPermissions["retired (no longer granted)"] = retiredPermissions;
  }

  return (
    <>
      <div className="t-permissions-actions-top">
        <Button
          variant="secondary"
          onClick={handleSelectAll}
          size="sm"
          fullWidth={false}
        >
          Select All
        </Button>
        <Button
          variant="secondary"
          onClick={handleClearAll}
          size="sm"
          fullWidth={false}
        >
          Clear All
        </Button>
      </div>

      <div className="t-permissions-groups">
        {Object.entries(groupedPermissions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, permissions]) => (
            <div key={group} className="t-permission-group">
              <h4 className="t-permission-group-title">{group}</h4>
              <div className="t-permission-group-items">
                {permissions
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((permission) => (
                    <div key={permission.id} className="t-permission-item">
                      <Checkbox
                        label={permission.displayName}
                        labelLocation="right"
                        checked={selectedPermissionIds.includes(permission.id)}
                        onChange={() => handleTogglePermission(permission.id)}
                      />
                    </div>
                  ))}
              </div>
            </div>
          ))}
      </div>
    </>
  );
});

RolePermissionsEditor.displayName = "RolePermissionsEditor";
