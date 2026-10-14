import useBucketPermissions from "@/features/file-storage/api/buckets/useBucketPermissions";
import useInfiniteShares from "@/features/file-storage/api/shares/useInfiniteShares";
import type { Share } from "@/features/file-storage/api/shares/types";
import { faCopy, faEdit } from "@fortawesome/free-solid-svg-icons";
import RevokeShareButton from "../buttons/RevokeShareButton";
import EditShareModal from "../modals/EditShareModal";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { userLabel } from "@/lib/refs";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  Badge,
  IconButton,
  InfiniteScroll,
  RowActions,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

interface ShareManagerProps {
  bucketName: string;
}

/**
 * Read-only bucket Shares tab. Lists existing shares and lets the caller
 * copy links or revoke. Share creation lives inline on the file tree —
 * this surface is for management only, so there is no "Add New" affordance.
 */
const ShareManager = ({ bucketName }: ShareManagerProps) => {
  const { hasPermission, user } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteShares(bucketName);
  const { data: grant } = useBucketPermissions(bucketName);
  const [editingShare, setEditingShare] = useState<Share | null>(null);

  // Core lets a share's creator edit or revoke it; anyone else needs write
  // (to edit) or delete (to revoke) access to the bucket's objects.
  const me = user?.sub;
  const mayEdit = hasPermission("file-service.shares.write");
  const mayRevoke = hasPermission("file-service.shares.delete");
  const bucketWrite =
    hasPermission("file-service.objects.write") && !!grant?.canWrite;
  const bucketDelete =
    hasPermission("file-service.objects.delete") && !!grant?.canDelete;

  const copyLink = async (url: string | null) => {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Clipboard blocked");
    }
  };

  const columns: TableColumn<Share>[] = useMemo(
    () => [
      {
        title: "Target",
        width: "22rem",
        cellElement: (share) => {
          const label =
            share.kind === "OBJECT"
              ? (share.object?.objectKey ?? share.objectId ?? "—")
              : (share.archiveRequest?.filename ?? "(archive)");
          return <div className="t-share-target">{label}</div>;
        },
      },
      {
        title: "Kind",
        dataKey: "kind",
        width: "7rem",
        cellElement: (share) => (
          <Badge variant={share.kind === "OBJECT" ? "primary" : "secondary"}>
            {share.kind}
          </Badge>
        ),
      },
      {
        title: "Status",
        dataKey: "status",
        width: "7rem",
        cellElement: (share) => {
          const variant =
            share.status === "active"
              ? "success"
              : share.status === "revoked"
                ? "danger"
                : "warning";
          return <Badge variant={variant}>{share.status}</Badge>;
        },
      },
      {
        title: "Password",
        dataKey: "hasPassword",
        width: "7rem",
        align: "center",
        cellElement: (share) => (share.hasPassword ? "Yes" : "—"),
      },
      {
        title: "Downloads",
        dataKey: "downloadCount",
        width: "8rem",
        align: "center",
        cellElement: (share) =>
          share.maxDownloads
            ? `${share.downloadCount} / ${share.maxDownloads}`
            : String(share.downloadCount),
      },
      {
        title: "Expires",
        dataKey: "expiresAt",
        width: "12rem",
        cellElement: (share) =>
          share.expiresAt
            ? new Date(share.expiresAt).toLocaleString()
            : // Only shares from before expiries were required, until the
              // share sweep gives them one.
              "not yet set",
      },
      {
        title: "Created",
        dataKey: "createdAt",
        width: "12rem",
        cellElement: (share) => new Date(share.createdAt).toLocaleString(),
      },
      {
        title: "Created By",
        width: "12rem",
        cellElement: (share) =>
          share.creator ? (
            <span title={share.creator.email}>{userLabel(share.creator)}</span>
          ) : (
            "—"
          ),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "10rem",
        align: "center",
        cellElement: (share) => (
          <RowActions>
            {share.url !== null && (
              <IconButton
                icon={faCopy}
                onClick={() => copyLink(share.url)}
                variant="light"
                size="sm"
                aria-label="Copy link"
              />
            )}
            {share.status !== "revoked" &&
              mayEdit &&
              (share.createdByUserId === me || bucketWrite) && (
                <IconButton
                  icon={faEdit}
                  onClick={() => setEditingShare(share)}
                  variant="primary"
                  size="sm"
                  aria-label="Edit share"
                />
              )}
            {share.status === "active" &&
              mayRevoke &&
              (share.createdByUserId === me || bucketDelete) && (
                <RevokeShareButton bucketName={bucketName} share={share} />
              )}
          </RowActions>
        ),
      },
    ],
    [bucketName, me, mayEdit, mayRevoke, bucketWrite, bucketDelete]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Shares",
      filters: [
        {
          type: "SELECT",
          title: "Kind",
          dataKey: "kind",
          options: [
            { id: "OBJECT", name: "Object", selected: false },
            { id: "ARCHIVE", name: "Archive", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "createdAt", displayName: "Created", selected: true },
          { dataKey: "expiresAt", displayName: "Expires", selected: false },
          {
            dataKey: "downloadCount",
            displayName: "Downloads",
            selected: false,
          },
        ],
        sortDirection: "desc",
      },
    }),
    []
  );

  if (!hasPermission("file-service.shares.read")) return null;

  return (
    <div className="t-share-manager">
      <InfiniteScroll<Share>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        hideSelectColumn
      />
      <EditShareModal
        bucketName={bucketName}
        share={editingShare}
        show={editingShare !== null}
        onClose={() => setEditingShare(null)}
      />
    </div>
  );
};

export default ShareManager;
