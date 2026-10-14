import { Button, IconButton, Input, Spinner } from "@kosmeo-ui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import useObjectPrefixes, {
  type PrefixEntry,
} from "../../api/objects/useObjectPrefixes";
import {
  faChevronDown,
  faChevronRight,
  faFolder,
} from "@fortawesome/free-solid-svg-icons";

interface FolderTreePickerProps {
  bucketName: string;
  /** Currently selected folder prefix. `""` represents the bucket root. */
  value: string;
  onChange: (prefix: string) => void;
  /**
   * Client-only folders to merge into the tree. Values are full prefixes
   * ending in `/` (e.g. `reports/2026/`).
   */
  virtualFolders: Set<string>;
  /** Prefix under which the pending "new folder" input should render, or null. */
  creatingUnder: string | null;
  newFolderName: string;
  createFolderError: string;
  onNewFolderNameChange: (name: string) => void;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
}

/**
 * Lazy-loading folder picker. Each node fetches its own children only when
 * expanded, so opening the picker is a single request for the root listing.
 * Client-only folders (passed via `virtualFolders`) are merged into the tree
 * at the level where they belong. When `creatingUnder` is set to a prefix,
 * that node renders an inline input for naming a new child folder at the
 * position where the folder will appear in the tree.
 */
const FolderTreePicker = (props: FolderTreePickerProps) => {
  return (
    <div className="t-folder-tree-picker">
      <FolderNode {...props} prefix="" label="Root" initiallyExpanded />
    </div>
  );
};

interface FolderNodeProps extends Omit<FolderTreePickerProps, "bucketName"> {
  bucketName: string;
  prefix: string;
  label: string;
  initiallyExpanded?: boolean;
}

const FolderNode = ({
  bucketName,
  prefix,
  label,
  value,
  onChange,
  virtualFolders,
  creatingUnder,
  newFolderName,
  createFolderError,
  onNewFolderNameChange,
  onConfirmCreate,
  onCancelCreate,
  initiallyExpanded = false,
}: FolderNodeProps) => {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { data, isLoading } = useObjectPrefixes(bucketName, prefix, expanded);

  const isCreatingHere = creatingUnder === prefix;

  // Force-expand when the user starts creating a new folder under this node so
  // the pending input is actually visible.
  useEffect(() => {
    if (isCreatingHere && !expanded) setExpanded(true);
  }, [isCreatingHere, expanded]);

  // Virtual child prefixes of this node — folders the user created client-side
  // that are direct children of the current prefix. Prefixes stored in the
  // set look like `${prefix}segment/`.
  const virtualChildren = useMemo(() => {
    const prefixLen = prefix.length;
    const children: string[] = [];
    for (const vf of virtualFolders) {
      if (!vf.startsWith(prefix)) continue;
      const rest = vf.slice(prefixLen, -1); // strip trailing `/`
      if (rest === "" || rest.includes("/")) continue; // not a direct child
      children.push(vf);
    }
    return children;
  }, [virtualFolders, prefix]);

  const subfolders = useMemo(() => {
    const fetched = (data?.data ?? []).filter(
      (e): e is PrefixEntry => e.type === "prefix"
    );
    const seen = new Set(fetched.map((e) => e.prefix));
    const merged = [...fetched.map((e) => e.prefix)];
    for (const vf of virtualChildren) {
      if (!seen.has(vf)) merged.push(vf);
    }
    merged.sort((a, b) => a.localeCompare(b));
    return merged;
  }, [data, virtualChildren]);

  const isSelected = value === prefix;
  const showChildren = expanded || isCreatingHere;

  return (
    <div className="t-folder-tree-node">
      <div
        className={`t-folder-tree-row ${isSelected ? "t-folder-tree-row-selected" : ""}`}
      >
        <IconButton
          icon={expanded ? faChevronDown : faChevronRight}
          variant="light"
          size="sm"
          shadow={false}
          fullWidth={false}
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
        />
        <IconButton
          icon={faFolder}
          variant="light"
          size="sm"
          shadow={false}
          align="left"
          onClick={() => {
            onChange(prefix);
            setExpanded(true);
          }}
        >
          <span className="t-folder-tree-name">{label}</span>
        </IconButton>
      </div>
      {showChildren && (
        <div className="t-folder-tree-children">
          {isLoading && (
            <div className="v-help-text">
              <Spinner size="sm" />
            </div>
          )}
          {!isLoading && subfolders.length === 0 && !isCreatingHere && (
            <div className="v-help-text">No subfolders</div>
          )}
          {subfolders.map((child) => (
            <FolderNode
              key={child}
              bucketName={bucketName}
              prefix={child}
              label={child.slice(prefix.length).replace(/\/$/, "")}
              value={value}
              onChange={onChange}
              virtualFolders={virtualFolders}
              creatingUnder={creatingUnder}
              newFolderName={newFolderName}
              createFolderError={createFolderError}
              onNewFolderNameChange={onNewFolderNameChange}
              onConfirmCreate={onConfirmCreate}
              onCancelCreate={onCancelCreate}
            />
          ))}
          {isCreatingHere && (
            <div className="t-folder-tree-pending">
              <div className="t-folder-tree-pending-row">
                <FontAwesomeIcon
                  icon={faFolder}
                  className="t-folder-tree-pending-icon"
                />
                <Input
                  value={newFolderName}
                  onChange={(e) => onNewFolderNameChange(e.target.value)}
                  placeholder="new-folder-name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onConfirmCreate();
                    if (e.key === "Escape") onCancelCreate();
                  }}
                />
                <Button size="sm" onClick={onConfirmCreate}>
                  Create
                </Button>
                <Button size="sm" variant="secondary" onClick={onCancelCreate}>
                  Cancel
                </Button>
              </div>
              {createFolderError && (
                <div className="t-folder-tree-pending-error">
                  {createFolderError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FolderTreePicker;
