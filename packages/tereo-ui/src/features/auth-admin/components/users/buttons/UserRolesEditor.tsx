import useSetUserRoles from "@/features/auth-admin/api/users/useSetUserRoles";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { useState, useImperativeHandle, forwardRef } from "react";
import { UserRole } from "@/features/auth-admin/api/users/types";
import { CheckboxGroup, Spinner } from "@kosmeo-ui/react";
import "../../roles/styles.css";

export interface UserRolesEditorRef {
  save: () => void;
}

interface UserRolesEditorProps {
  userId: string;
  currentRoles: UserRole[];
  onSuccess: () => void;
}

export const UserRolesEditor = forwardRef<
  UserRolesEditorRef,
  UserRolesEditorProps
>(({ userId, currentRoles, onSuccess }, ref) => {
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(
    currentRoles.map((r) => r.id)
  );

  const { data, isLoading } = useAllRoles();
  const mutation = useSetUserRoles();

  // Assignable roles: core lists only unarchived, unretired ones and refuses
  // the rest, so an assignment to a retired/archived role is dropped on save.
  const activeRoles = data?.filter((role) => role.isActive) || [];

  useImperativeHandle(ref, () => ({
    save: () => {
      const assignable = new Set(activeRoles.map((r) => r.id));
      mutation.mutate(
        {
          userId,
          roleIds: selectedRoleIds.filter((id) => assignable.has(id)),
        },
        { onSuccess }
      );
    },
  }));

  if (isLoading) {
    return (
      <div className="t-roles-editor-loading">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <CheckboxGroup
      name="user-roles"
      options={activeRoles.map((role) => ({
        value: role.id,
        label: role.isSystem
          ? `${role.displayName} (system)`
          : role.displayName,
      }))}
      values={selectedRoleIds}
      onChange={setSelectedRoleIds}
    />
  );
});

UserRolesEditor.displayName = "UserRolesEditor";
