import useRestoreObjectVersion from "@/features/file-storage/api/objects/useRestoreObjectVersion";
import useDeleteObjectVersion from "@/features/file-storage/api/objects/useDeleteObjectVersion";
import useBucketPermissions from "@/features/file-storage/api/buckets/useBucketPermissions";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import formatBytes from "@/utils/formatBytes";
import { useMemo, useState } from "react";
import { userLabel } from "@/lib/refs";
import { useAuth } from "@/lib/auth";
import useInfiniteObjectVersions, {
  type ObjectVersion,
} from "@/features/file-storage/api/objects/useInfiniteObjectVersions";
import {
  Badge,
  Button,
  ConfirmationModal,
  IconButton,
  InfiniteScroll,
  RowActions,
  type TableColumn,
  type InfiniteScrollMenu,
  Modal,
} from "@kosmeo-ui/react";

const VersionCreator = ({ version }: { version: ObjectVersion }) => (
  <>{version.creator ? userLabel(version.creator) : version.createdBy}</>
);

interface ObjectVersionsModalProps {
  bucketName: string;
  /** Stable UUID id — drives all version mutations. */
  objectId: string;
  /** Current `objectKey`, used only for display in the modal title. */
  objectKey: string;
  show: boolean;
  onClose: () => void;
}

const ObjectVersionsModal = ({
  bucketName,
  objectId,
  objectKey,
  show,
  onClose,
}: ObjectVersionsModalProps) => {
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteObjectVersions(bucketName, objectId, { enabled: show });

  const { mutate: restore, isPending: isRestoring } = useRestoreObjectVersion(
    bucketName,
    objectId
  );
  const { mutate: hardDelete, isPending: isDeleting } = useDeleteObjectVersion(
    bucketName,
    objectId
  );

  const [versionPendingDelete, setVersionPendingDelete] =
    useState<ObjectVersion | null>(null);

  // Core checks the permission and the caller's grant on the bucket: restore
  // needs objects.write and canWrite, deleting a version objects.delete and
  // canDelete.
  const { data: grant } = useBucketPermissions(show ? bucketName : undefined);
  const canRestore =
    hasPermission("file-service.objects.write") && !!grant?.canWrite;
  const canDelete =
    hasPermission("file-service.objects.delete") && !!grant?.canDelete;

  // Restore creates a new ObjectVersion pointing at the source's blob — the
  // user shouldn't see that phantom row. Hide every version that carries a
  // `restoredFromVersionId` and promote the resolved source to the "current"
  // slot visually. If the source isn't in loaded data (large histories where
  // the source is paginated past the current phantom) we fall back to leaving
  // the phantom visible so the list still has a current row.
  const visibleVersions = useMemo(() => {
    const byId = new Map(data.map((v) => [v.versionId, v]));
    const resolveSourceId = (v: ObjectVersion): string | null => {
      let cursor: ObjectVersion | undefined = v;
      const seen = new Set<string>();
      while (cursor?.restoredFromVersionId) {
        if (seen.has(cursor.versionId)) return null;
        seen.add(cursor.versionId);
        cursor = byId.get(cursor.restoredFromVersionId);
      }
      return cursor && cursor.versionId !== v.versionId
        ? cursor.versionId
        : null;
    };

    const currentPhantom = data.find(
      (v) => v.isCurrent && v.restoredFromVersionId !== null
    );
    const currentPhantomSourceId = currentPhantom
      ? resolveSourceId(currentPhantom)
      : null;
    const canHideCurrentPhantom =
      currentPhantomSourceId !== null && byId.has(currentPhantomSourceId);

    return data
      .filter((v) => {
        if (v.restoredFromVersionId === null) return true;
        if (v === currentPhantom && !canHideCurrentPhantom) return true;
        return false;
      })
      .map((v) => ({
        ...v,
        isCurrent: v.isCurrent || v.versionId === currentPhantomSourceId,
      }));
  }, [data]);

  const columns: TableColumn<ObjectVersion>[] = useMemo(
    () => [
      {
        title: "Created",
        dataKey: "createdAt",
        cellElement: (v) => new Date(v.createdAt).toLocaleString(),
      },
      {
        title: "Created by",
        cellElement: (v) => <VersionCreator version={v} />,
      },
      {
        title: "Type",
        cellElement: (v) => v.contentType ?? "—",
      },
      {
        title: "Size",
        align: "right",
        cellElement: (v) => (v.sizeBytes ? formatBytes(v.sizeBytes) : "—"),
      },
      {
        title: "Status",
        cellElement: (v) => (
          <>
            {v.isCurrent && <Badge variant="success">current</Badge>}
            {v.isDeleteMarker && <Badge variant="warning">delete marker</Badge>}
          </>
        ),
      },
      {
        title: "Actions",
        disableRowClick: true,
        align: "center",
        cellElement: (v) => (
          <RowActions align="center">
            {!v.isCurrent && !v.isDeleteMarker && canRestore && (
              <Button
                size="sm"
                variant="light"
                onClick={() => restore(v.versionId)}
                disabled={isRestoring}
              >
                Restore
              </Button>
            )}
            {!v.isCurrent && canDelete && (
              <IconButton
                icon={faTrash}
                title="Delete"
                size="sm"
                variant="danger"
                onClick={() => setVersionPendingDelete(v)}
                disabled={isDeleting}
              />
            )}
          </RowActions>
        ),
      },
    ],
    [canRestore, canDelete, isRestoring, isDeleting, restore]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: `Version history · ${objectKey}`,
      sort: {
        sortDataKeys: [
          { dataKey: "createdAt", displayName: "Created", selected: true },
        ],
        sortDirection: "desc",
      },
    }),
    [objectKey]
  );

  return (
    <>
      <Modal size="lg" show={show} onClose={onClose} title="Version history">
        <InfiniteScroll<ObjectVersion>
          menu={menu}
          data={visibleVersions}
          hasMore={hasMore}
          isLoading={isLoading}
          onQueryChange={onQueryChange}
          onReload={reload}
          columns={columns}
          hideFilters
          hideSelectColumn
          hideNextPageButton
          emptyMessage="No versions found."
        />
      </Modal>

      <ConfirmationModal
        show={!!versionPendingDelete}
        handleHide={() => setVersionPendingDelete(null)}
        handleConfirm={() => {
          if (!versionPendingDelete) return;
          hardDelete(versionPendingDelete.versionId, {
            onSuccess: () => setVersionPendingDelete(null),
          });
        }}
        title="Delete version"
        body={`Delete version ${versionPendingDelete?.versionId.slice(0, 8) ?? ""}? This cannot be undone.`}
        confirmButtonText="Delete"
        isLoading={isDeleting}
      />
    </>
  );
};

export default ObjectVersionsModal;
