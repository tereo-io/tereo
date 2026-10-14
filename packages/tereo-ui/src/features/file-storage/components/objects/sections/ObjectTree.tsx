import useInfiniteObjectPrefixes from "@/features/file-storage/api/objects/useInfiniteObjectPrefixes";
import useBucketPermissions from "@/features/file-storage/api/buckets/useBucketPermissions";
import { isBucketRetired } from "@/features/file-storage/api/buckets/bucketOwnership";
import useBucket from "@/features/file-storage/api/buckets/useBucket";
import { useParams, useSearchParams } from "react-router-dom";
import UploadObjectModal from "../modals/UploadObjectModal";
import ObjectSearchModal from "../modals/ObjectSearchModal";
import DeletedObjectsTable from "./DeletedObjectsTable";
import ObjectListTable from "./ObjectListTable";
import { useAuth } from "@/lib/auth";
import env from "@/lib/env";
import "../styles.css";
import {
  faFolderOpen,
  faMagnifyingGlass,
  faUpload,
  faArrowsRotate,
} from "@fortawesome/free-solid-svg-icons";
import {
  Breadcrumbs,
  IconButton,
  Switch,
  type Breadcrumb,
} from "@kosmeo-ui/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";

function buildCrumbs(
  bucketName: string,
  prefix: string,
  onSelect: (prefix: string) => void
): Breadcrumb[] {
  const basePath = `${env.BASE_PATH}/file-storage/buckets/${bucketName}?tab=objects`;
  const makePath = (p: string) =>
    p ? `${basePath}&prefix=${encodeURIComponent(p)}` : basePath;
  const makeCrumb = (p: string, label: string): Breadcrumb => ({
    label,
    path: makePath(p),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onSelect(p);
    },
  });

  const crumbs: Breadcrumb[] = [makeCrumb("", "root")];
  if (!prefix) return crumbs;

  const parts = prefix.replace(/\/$/, "").split("/");
  let accumulator = "";
  for (const part of parts) {
    accumulator += `${part}/`;
    crumbs.push(makeCrumb(accumulator, part));
  }
  return crumbs;
}

/**
 * Virtual-folder tree view over bucket objects. Renders whatever lives at the
 * current prefix: nested folders (common prefixes) and leaf objects. Navigation
 * is breadcrumb + click-to-enter, persisted in the URL via ?prefix=.
 */
const ObjectTree = () => {
  const { hasPermission } = useAuth();
  const { bucketName } = useParams<{ bucketName: string }>();
  const { data: permissions } = useBucketPermissions(bucketName);
  const { data: bucket } = useBucket(bucketName ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  // Persist currentPrefix in ?prefix= so refreshes and deep links work.
  // Mirrors the activeTab pattern in BucketDetail.tsx.
  const prefixFromUrl = searchParams.get("prefix") ?? "";
  const [currentPrefix, setCurrentPrefix] = useState(prefixFromUrl);

  useEffect(() => {
    const currentUrlPrefix = searchParams.get("prefix") ?? "";
    if (currentUrlPrefix !== currentPrefix) {
      const next = new URLSearchParams(searchParams);
      if (currentPrefix) {
        next.set("prefix", currentPrefix);
      } else {
        next.delete("prefix");
      }
      setSearchParams(next, { replace: true });
    }
  }, [currentPrefix, searchParams, setSearchParams]);

  // Only a versioned bucket keeps deleted objects' history to restore from.
  const [showDeleted, setShowDeleted] = useState(false);
  const listingDeleted = showDeleted && !!bucket?.versioningEnabled;
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [initialUploadFiles, setInitialUploadFiles] = useState<File[] | null>(
    null
  );
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // `webkitdirectory` isn't in React's DOM type map; set it imperatively once.
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  const handlePickerChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (picked && picked.length > 0) {
      setInitialUploadFiles(Array.from(picked));
      setShowUploadModal(true);
    }
    // Reset so re-picking the same files later still fires onChange.
    event.target.value = "";
  };

  const { data, isLoading, hasMore, onQueryChange, reload } =
    useInfiniteObjectPrefixes(bucketName, currentPrefix);

  const crumbs = useMemo(
    () => buildCrumbs(bucketName!, currentPrefix, setCurrentPrefix),
    [bucketName, currentPrefix]
  );

  if (!hasPermission("file-service.objects.read") || !permissions?.canRead) {
    return null;
  }

  // Retired buckets are read-only: uploads get 409 bucket_retired.
  const canUpload =
    hasPermission("file-service.objects.write") &&
    !!permissions?.canWrite &&
    !isBucketRetired(bucket);

  return (
    <div className="t-object-tree">
      <div className="t-object-tree-toolbar">
        <Breadcrumbs items={crumbs} />
        <div className="t-object-tree-actions">
          {bucket?.versioningEnabled && (
            <Switch
              size="sm"
              label="Show deleted"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
            />
          )}
          <IconButton
            icon={faMagnifyingGlass}
            variant="secondary"
            size="sm"
            onClick={() => setShowSearchModal(true)}
            aria-label="Search"
          />
          <IconButton
            icon={faArrowsRotate}
            variant="secondary"
            size="sm"
            onClick={reload}
            aria-label="Reload"
          />
          {canUpload && (
            <>
              <IconButton
                icon={faUpload}
                size="sm"
                onClick={() => filesInputRef.current?.click()}
              >
                Upload Files
              </IconButton>
              <IconButton
                icon={faFolderOpen}
                size="sm"
                onClick={() => folderInputRef.current?.click()}
              >
                Upload Folder
              </IconButton>
              <input
                ref={filesInputRef}
                type="file"
                multiple
                hidden
                onChange={handlePickerChange}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                hidden
                onChange={handlePickerChange}
              />
            </>
          )}
        </div>
      </div>

      {listingDeleted ? (
        <DeletedObjectsTable bucketName={bucketName!} prefix={currentPrefix} />
      ) : (
        <ObjectListTable
          bucketName={bucketName!}
          data={data}
          isLoading={isLoading}
          hasMore={hasMore}
          onQueryChange={onQueryChange}
          onReload={reload}
          onNavigateFolder={setCurrentPrefix}
          nameDisplayPrefix={currentPrefix}
          emptyMessage="This folder is empty."
        />
      )}

      <UploadObjectModal
        bucketName={bucketName!}
        show={showUploadModal}
        defaultPrefix={currentPrefix}
        initialFiles={initialUploadFiles ?? undefined}
        onUpload={() => {
          setShowUploadModal(false);
          setInitialUploadFiles(null);
          reload();
        }}
        onClose={() => {
          setShowUploadModal(false);
          setInitialUploadFiles(null);
        }}
      />

      <ObjectSearchModal
        bucketName={bucketName!}
        prefix={currentPrefix}
        show={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        onNavigate={setCurrentPrefix}
      />
    </div>
  );
};

export default ObjectTree;
