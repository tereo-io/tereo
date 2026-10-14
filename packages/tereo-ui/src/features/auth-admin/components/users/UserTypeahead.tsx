import useInitialUsers from "@/features/auth-admin/api/users/useInitialUsers";
import useSearchUsers from "@/features/auth-admin/api/users/useSearchUsers";
import type { UserListItem } from "@/features/auth-admin/types/user";
import { SearchList } from "@kosmeo-ui/react";

interface UserTypeaheadProps {
  label?: string;
  value: UserListItem | null;
  onSelect: (user: UserListItem | null) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  initialOptions?: UserListItem[];
}

export const UserTypeahead = ({
  label = "User",
  value,
  onSelect,
  required,
  disabled,
  placeholder = "Search by email...",
  initialOptions,
}: UserTypeaheadProps) => {
  const { data: fetchedInitial } = useInitialUsers(!initialOptions);
  const options = initialOptions ?? fetchedInitial;

  return (
    <SearchList<UserListItem>
      label={label}
      queryFn={useSearchUsers}
      onSelect={onSelect}
      value={value}
      labelKey="email"
      searchKey="email"
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      initialOptions={options}
      renderOption={(user) => ({
        label: user.email,
        node: (
          <div>
            <div className="t-package-sku">{user.email}</div>
            {user.name && <small className="v-muted-text">{user.name}</small>}
          </div>
        ),
      })}
    />
  );
};

export default UserTypeahead;
