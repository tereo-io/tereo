import triggerArchiveDownload from "@/features/file-storage/api/archives/triggerArchiveDownload";
import useBucketPermissions from "@/features/file-storage/api/buckets/useBucketPermissions";
import { isBucketRetired } from "@/features/file-storage/api/buckets/bucketOwnership";
import useCreateArchive from "@/features/file-storage/api/archives/useCreateArchive";
import BulkDeleteObjectsButton from "../buttons/BulkDeleteObjectsButton";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import ShareObjectButton from "../../shares/buttons/ShareObjectButton";
import ShareFolderButton from "../../shares/buttons/ShareFolderButton";
import useBucket from "@/features/file-storage/api/buckets/useBucket";
import CreateShareModal from "../../shares/modals/CreateShareModal";
import DownloadFolderButton from "../buttons/DownloadFolderButton";
import DownloadObjectButton from "../buttons/DownloadObjectButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import ObjectVersionsModal from "../modals/ObjectVersionsModal";
import DeleteObjectButton from "../buttons/DeleteObjectButton";
import DeleteFolderButton from "../buttons/DeleteFolderButton";
import EditObjectButton from "../buttons/EditObjectButton";
import ObjectThumbnail from "./ObjectThumbnail";
import formatBytes from "@/utils/formatBytes";
import { toast } from "react-toastify";
import { useAuth } from "@/lib/auth";
import type {
  PrefixListEntry,
  PrefixObject,
} from "@/features/file-storage/api/objects/useObjectPrefixes";
import {
  faDownload,
  faFolder,
  faShareNodes,
} from "@fortawesome/free-solid-svg-icons";
import {
  BorderedSection,
  Button,
  IconButton,
  InfiniteScroll,
  RowActions,
  type TableColumn,
  type TableRow,
} from "@kosmeo-ui/react";

interface ObjectListTableProps {
  bucketName: string;
  data: PrefixListEntry[];
  isLoading: boolean;
  hasMore: boolean;
  onQueryChange: (queryString: string) => void;
  onReload: () => void;
  /** Title shown in the InfiniteScroll menu header. */
  menuTitle?: string;
  /** Empty-state message. */
  emptyMessage?: string;
  /**
   * When provided, folder rows are clickable and call this with the new prefix.
   * Omit for views (e.g. search results) that don't navigate folders.
   */
  onNavigateFolder?: (prefix: string) => void;
  /**
   * Sliced off object keys before rendering, so the tree can show a key
   * relative to its current folder. Default is empty (full path shown).
   */
  nameDisplayPrefix?: string;
  /**
   * Rendered immediately before the standard action buttons on object rows.
   * Use for view-specific actions like "Go to folder" in search results.
   */
  extraObjectActions?: (entry: PrefixObject) => ReactNode;
}

const ObjectListTable = ({
  bucketName,
  data,
  isLoading,
  hasMore,
  onQueryChange,
  onReload,
  menuTitle = "Objects",
  emptyMessage = "No objects found.",
  onNavigateFolder,
  nameDisplayPrefix = "",
  extraObjectActions,
}: ObjectListTableProps) => {
  const { hasPermission } = useAuth();
  const { data: bucket } = useBucket(bucketName);
  const { data: permissions } = useBucketPermissions(bucketName);

  const [versionsTarget, setVersionsTarget] = useState<{
    id: string;
    key: string;
  } | null>(null);

  const canDelete =
    hasPermission("file-service.objects.delete") && !!permissions?.canDelete;
  // A retired bucket answers writes (rename, metadata edits) with 409;
  // reads, downloads, shares and deletes still work.
  const canWrite =
    hasPermission("file-service.objects.write") &&
    !!permissions?.canWrite &&
    !isBucketRetired(bucket);
  const versioningEnabled = bucket?.versioningEnabled;

  // `createArchive` works for both selection cases: a bundle of loose objects
  // (by key) and a single prefix. Folder rows inside a multi-select selection
  // are handled via separate per-prefix archive calls — mirrors how delete
  // currently does one bulk-delete per selected folder.
  const { mutateAsync: createArchiveAsync, isPending: archivePending } =
    useCreateArchive(bucketName);

  // InfiniteScroll owns selection state and hands us the selected rows on
  // every change via onRowSelect. We mirror it here purely to drive the
  // confirmation modal (counts + button enablement) and reset on delete.
  const [selectedRows, setSelectedRows] = useState<TableRow<PrefixListEntry>[]>(
    []
  );
  const [bulkShareSeed, setBulkShareSeed] = useState<
    { prefix: string; keys?: never } | { keys: string[]; prefix?: never } | null
  >(null);

  const canShare = hasPermission("file-service.shares.write");

  // InfiniteScroll fires this on every select/deselect. Memoized because the
  // component re-runs its onRowSelect effect on every data update and would
  // otherwise churn the callback reference.
  const handleRowSelect = useCallback(
    (rows: TableRow<PrefixListEntry>[]) => setSelectedRows(rows),
    []
  );

  const selectedPrefixes = useMemo(
    () =>
      selectedRows
        .filter((r) => r.data.type === "prefix")
        .map(
          (r) => (r.data as Extract<PrefixListEntry, { type: "prefix" }>).prefix
        ),
    [selectedRows]
  );
  const selectedIds = useMemo(
    () =>
      selectedRows
        .filter((r) => r.data.type === "object")
        .map((r) => (r.data as PrefixObject).id),
    [selectedRows]
  );
  const selectedKeys = useMemo(
    () =>
      selectedRows
        .filter((r) => r.data.type === "object")
        .map((r) => (r.data as PrefixObject).key),
    [selectedRows]
  );

  const handleBulkDownload = async () => {
    // Each selected folder becomes its own archive download (preserves the
    // folder-as-zip naming) and the loose objects go in a single keys-based
    // archive. One server round-trip per folder is worth the cleaner output
    // on the user's filesystem. Errors surface via the mutation's toast.
    try {
      for (const prefix of selectedPrefixes) {
        const res = await createArchiveAsync({ prefix, format: "zip" });
        triggerArchiveDownload(res.url);
      }
      if (selectedKeys.length > 0) {
        const res = await createArchiveAsync({
          keys: selectedKeys,
          format: "zip",
        });
        triggerArchiveDownload(res.url);
        toast.success(
          `Downloading ${res.objectCount.toLocaleString()} file${
            res.objectCount === 1 ? "" : "s"
          } as ${res.filename}`
        );
      }
    } catch {
      // Hook already surfaces the error toast; swallow to avoid a second one.
    }
  };

  /**
   * "Share Selected" in the multi-select bar. The backend ARCHIVE share accepts
   * either `prefix` (single) or `keys` (list), not both. Map the selection to
   * whichever fits and surface a clear error for the un-shareable shapes:
   *
   * - 1 folder, 0 objects         → prefix share
   * - 0 folders, ≥1 objects       → keys share
   * - ≥2 folders                  → reject (would need multiple share rows)
   * - folders mixed with objects  → reject (mixing ARCHIVE inputs isn't supported)
   */
  const handleBulkShare = () => {
    if (selectedPrefixes.length === 1 && selectedKeys.length === 0) {
      setBulkShareSeed({ prefix: selectedPrefixes[0] });
      return;
    }
    if (selectedPrefixes.length === 0 && selectedKeys.length > 0) {
      setBulkShareSeed({ keys: selectedKeys });
      return;
    }
    if (selectedPrefixes.length >= 2) {
      toast.error(
        "Share one folder at a time — each share is a single archive."
      );
      return;
    }
    toast.error(
      "Can't share a mix of folders and files. Select only files, or only one folder."
    );
  };

  const handleBulkDeleted = useCallback(() => {
    setSelectedRows([]);
    onReload();
  }, [onReload]);

  const columns: TableColumn<PrefixListEntry>[] = useMemo(
    () => [
      {
        title: "Name",
        cellElement: (entry) => {
          if (entry.type === "prefix") {
            const label = entry.prefix
              .slice(nameDisplayPrefix.length)
              .replace(/\/$/, "");
            const inner = (
              <>
                <span className="t-object-tree-icon">
                  <FontAwesomeIcon icon={faFolder} />
                </span>
                <span className="t-object-tree-name">{label}</span>
              </>
            );
            return onNavigateFolder ? (
              <Button
                variant="link"
                align="left"
                fullWidth={false}
                shadow={false}
                onClick={() => onNavigateFolder(entry.prefix)}
              >
                {inner}
              </Button>
            ) : (
              <div className="t-object-tree-name-cell">{inner}</div>
            );
          }
          return (
            <div className="t-object-tree-name-cell">
              <span className="t-object-tree-icon">
                <ObjectThumbnail
                  bucketName={bucketName}
                  objectKey={entry.key}
                  contentType={entry.contentType}
                />
              </span>
              <span className="t-object-tree-name">
                {entry.key.slice(nameDisplayPrefix.length)}
              </span>
            </div>
          );
        },
      },
      {
        title: "Type",
        width: "12rem",
        cellElement: (entry) =>
          entry.type === "prefix" ? "Folder" : entry.contentType,
      },
      {
        title: "Items",
        align: "right",
        width: "7rem",
        cellElement: (entry) =>
          entry.type === "prefix" ? entry.objectCount.toLocaleString() : "—",
      },
      {
        title: "Size",
        align: "right",
        width: "8rem",
        cellElement: (entry) =>
          formatBytes(
            entry.type === "prefix" ? entry.totalSizeBytes : entry.sizeBytes
          ),
      },
      {
        title: "Modified",
        align: "right",
        width: "12rem",
        cellElement: (entry) =>
          entry.type === "prefix"
            ? "—"
            : new Date(entry.updatedAt).toLocaleString(),
      },
      {
        title: "Actions",
        align: "center",
        width: "22rem",
        disableRowClick: true,
        cellElement: (entry) => {
          if (entry.type === "prefix") {
            // Folder label = last non-empty path segment (e.g.
            // "images/2024/" → "2024"). Matches what the Name cell renders.
            const label = entry.prefix
              .slice(nameDisplayPrefix.length)
              .replace(/\/$/, "");
            return (
              <RowActions align="center">
                <DownloadFolderButton
                  bucketName={bucketName}
                  prefix={entry.prefix}
                  label={label}
                  objectCount={entry.objectCount}
                />
                <ShareFolderButton
                  bucketName={bucketName}
                  prefix={entry.prefix}
                  label={label}
                  objectCount={entry.objectCount}
                />
                {canDelete && (
                  <DeleteFolderButton
                    bucketName={bucketName}
                    prefix={entry.prefix}
                    label={label}
                    objectCount={entry.objectCount}
                    onDelete={onReload}
                  />
                )}
              </RowActions>
            );
          }
          return (
            <RowActions align="center">
              {extraObjectActions?.(entry)}
              {versioningEnabled && (
                <Button
                  variant="light"
                  onClick={() =>
                    setVersionsTarget({ id: entry.id, key: entry.key })
                  }
                >
                  Versions
                </Button>
              )}
              <DownloadObjectButton
                bucketName={bucketName}
                object={{ id: entry.id }}
              />
              <ShareObjectButton
                bucketName={bucketName}
                object={{ id: entry.id, key: entry.key }}
              />
              {canWrite && (
                <EditObjectButton
                  bucketName={bucketName}
                  object={{ id: entry.id, key: entry.key }}
                  versioningEnabled={!!versioningEnabled}
                  onUpdate={onReload}
                />
              )}
              {canDelete && (
                <DeleteObjectButton
                  bucketName={bucketName}
                  object={{ id: entry.id, key: entry.key }}
                  onDelete={onReload}
                />
              )}
            </RowActions>
          );
        },
      },
    ],
    [
      bucketName,
      canDelete,
      canWrite,
      extraObjectActions,
      nameDisplayPrefix,
      onNavigateFolder,
      onReload,
      versioningEnabled,
    ]
  );

  const selectionSummary = (() => {
    const parts: string[] = [];
    if (selectedPrefixes.length > 0) {
      parts.push(
        `${selectedPrefixes.length} folder${
          selectedPrefixes.length === 1 ? "" : "s"
        }`
      );
    }
    if (selectedIds.length > 0) {
      parts.push(
        `${selectedIds.length} object${selectedIds.length === 1 ? "" : "s"}`
      );
    }
    return parts.join(" and ");
  })();

  return (
    <>
      {selectedRows.length > 0 && (
        <BorderedSection layout="row">
          <span>
            <strong>{selectedRows.length}</strong> selected ({selectionSummary})
          </span>
          <RowActions align="end" gap="sm">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelectedRows([])}
              disabled={archivePending}
            >
              Clear
            </Button>
            <IconButton
              icon={faDownload}
              size="sm"
              variant="primary"
              onClick={handleBulkDownload}
              disabled={archivePending}
            >
              Download Selected
            </IconButton>
            {canShare && (
              <IconButton
                icon={faShareNodes}
                size="sm"
                variant="secondary"
                onClick={handleBulkShare}
                disabled={archivePending}
              >
                Share Selected
              </IconButton>
            )}
            {canDelete && (
              <BulkDeleteObjectsButton
                bucketName={bucketName}
                selectedPrefixes={selectedPrefixes}
                selectedIds={selectedIds}
                selectionSummary={selectionSummary}
                disabled={archivePending}
                onDeleted={handleBulkDeleted}
              />
            )}
          </RowActions>
        </BorderedSection>
      )}

      <InfiniteScroll<PrefixListEntry>
        menu={{ title: menuTitle }}
        columns={columns}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        onReload={onReload}
        hideFilters
        onRowSelect={handleRowSelect}
        hideNextPageButton
        emptyMessage={emptyMessage}
      />

      {versionsTarget && (
        <ObjectVersionsModal
          bucketName={bucketName}
          objectId={versionsTarget.id}
          objectKey={versionsTarget.key}
          show={!!versionsTarget}
          onClose={() => setVersionsTarget(null)}
        />
      )}

      <CreateShareModal
        bucketName={bucketName}
        show={bulkShareSeed !== null}
        onClose={() => setBulkShareSeed(null)}
        seedPrefix={
          bulkShareSeed && "prefix" in bulkShareSeed
            ? bulkShareSeed.prefix
            : null
        }
        seedKeys={
          bulkShareSeed && "keys" in bulkShareSeed ? bulkShareSeed.keys : null
        }
      />
    </>
  );
};

export default ObjectListTable;
