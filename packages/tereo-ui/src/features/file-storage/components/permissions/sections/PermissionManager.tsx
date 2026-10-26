import useInfinitePermissions from "@/features/file-storage/api/permissions/useInfinitePermissions";
import { isDeclaringServiceGrant } from "@/features/file-storage/api/buckets/bucketOwnership";
import type { BucketPermission } from "@/features/file-storage/api/permissions/types";
import type { Bucket } from "@/features/file-storage/api/buckets/types";
import RevokePermissionButton from "../buttons/RevokePermissionButton";
import { faCheck, faTimes } from "@fortawesome/free-solid-svg-icons";
import GrantPermissionModal from "../modals/GrantPermissionModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { formatDateTime } from "@/utils/formatDate";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  InfiniteScroll,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

interface PermissionManagerProps {
  bucket: Bucket;
  /** From `canManageBucket`; others with access see the list read-only. */
  canManage: boolean;
}

export const PermissionManager = ({
  bucket,
  canManage,
}: PermissionManagerProps) => {
  const bucketName = bucket.name;
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfinitePermissions(bucketName);
  const [showGrantModal, setShowGrantModal] = useState(false);

  const columns: TableColumn<BucketPermission>[] = useMemo(
    () => [
      {
        title: "User",
        dataKey: "userId",
        width: "20rem",
        cellElement: (permission) => (
          <div>
            <div className="v-text-semibold">
              {permission.userName ||
                permission.userEmail ||
                `User ${permission.userId}`}
            </div>
            {permission.userName && permission.userEmail && (
              <div className="v-help-text">{permission.userEmail}</div>
            )}
          </div>
        ),
      },
      {
        title: "Read",
        dataKey: "canRead",
        width: "8rem",
        align: "center",
        cellElement: (permission) =>
          permission.canRead ? (
            <FontAwesomeIcon icon={faCheck} className="v-text-success" />
          ) : (
            <FontAwesomeIcon icon={faTimes} className="v-text-danger" />
          ),
      },
      {
        title: "Write",
        dataKey: "canWrite",
        width: "8rem",
        align: "center",
        cellElement: (permission) =>
          permission.canWrite ? (
            <FontAwesomeIcon icon={faCheck} className="v-text-success" />
          ) : (
            <FontAwesomeIcon icon={faTimes} className="v-text-danger" />
          ),
      },
      {
        title: "Delete",
        dataKey: "canDelete",
        width: "8rem",
        align: "center",
        cellElement: (permission) =>
          permission.canDelete ? (
            <FontAwesomeIcon icon={faCheck} className="v-text-success" />
          ) : (
            <FontAwesomeIcon icon={faTimes} className="v-text-danger" />
          ),
      },
      {
        title: "Granted At",
        dataKey: "grantedAt",
        width: "12rem",
        cellElement: (permission) => formatDateTime(permission.grantedAt),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (permission) => {
          if (!canManage) return null;
          if (!hasPermission("file-service.permissions.delete")) return null;
          if (isDeclaringServiceGrant(bucket, permission.userId)) return null;
          return (
            <RevokePermissionButton
              bucketName={bucketName}
              permission={permission}
              onRevoke={reload}
            />
          );
        },
      },
    ],
    [bucket, bucketName, canManage, hasPermission, reload]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: `Permissions`,
      filters: [
        // Core filters userId by `equals` or `in` on whole ids, not by
        // `contains`, which a SEARCH filter sends.
        {
          type: "LIST",
          title: "User IDs",
          dataKey: "userId",
          list: "",
        },
        {
          type: "SELECT",
          title: "Can Read",
          dataKey: "canRead",
          options: [
            { id: "true", name: "Yes", selected: false },
            { id: "false", name: "No", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Can Write",
          dataKey: "canWrite",
          options: [
            { id: "true", name: "Yes", selected: false },
            { id: "false", name: "No", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Can Delete",
          dataKey: "canDelete",
          options: [
            { id: "true", name: "Yes", selected: false },
            { id: "false", name: "No", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "userId", displayName: "User ID", selected: true },
          {
            dataKey: "grantedAt",
            displayName: "Granted At",
            selected: false,
          },
        ],
        sortDirection: "asc",
      },
    }),
    [bucketName]
  );

  if (!hasPermission("file-service.permissions.read")) return null;
  return (
    <div className="v-tab-fill">
      <InfiniteScroll<BucketPermission>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          canManage && hasPermission("file-service.permissions.write")
            ? () => setShowGrantModal(true)
            : undefined
        }
        hideSelectColumn
      />
      <GrantPermissionModal
        bucketName={bucketName}
        organizationId={bucket.organizationId}
        show={showGrantModal}
        onGrant={() => {
          setShowGrantModal(false);
          reload();
        }}
        onClose={() => setShowGrantModal(false)}
      />
    </div>
  );
};
