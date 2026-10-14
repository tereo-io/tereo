import useInfiniteSearchObjects from "@/features/file-storage/api/objects/useInfiniteSearchObjects";
import { faFolderOpen } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import ObjectListTable from "../sections/ObjectListTable";
import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Input } from "@kosmeo-ui/react";
import type {
  PrefixListEntry,
  PrefixObject,
} from "@/features/file-storage/api/objects/useObjectPrefixes";

interface ObjectSearchModalProps {
  bucketName: string;
  /** Search is scoped to objects whose key starts with this prefix. */
  prefix: string;
  show: boolean;
  onClose: () => void;
  /** Called when the user clicks "Go to folder" on a result. */
  onNavigate: (prefix: string) => void;
}

const DEBOUNCE_MS = 300;

const parentPrefixOf = (key: string): string => {
  const lastSlash = key.lastIndexOf("/");
  return lastSlash === -1 ? "" : key.slice(0, lastSlash + 1);
};

const ObjectSearchModal = ({
  bucketName,
  prefix,
  show,
  onClose,
  onNavigate,
}: ObjectSearchModalProps) => {
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");

  // Reset input when the modal closes so a fresh open doesn't replay stale results.
  useEffect(() => {
    if (!show) {
      setInput("");
      setDebounced("");
    }
  }, [show]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteSearchObjects(bucketName, prefix, debounced, { enabled: show });

  // Adapt the search hook's payload into the discriminated union the shared
  // table expects. The wire shape is identical aside from the missing tag.
  const tableData: PrefixListEntry[] = data.map((o) => ({
    type: "object" as const,
    ...o,
  }));

  const handleNavigate = useCallback(
    (objectKey: string) => {
      onNavigate(parentPrefixOf(objectKey));
      onClose();
    },
    [onClose, onNavigate]
  );

  const extraObjectActions = useCallback(
    (entry: PrefixObject) => (
      <Button
        size="sm"
        variant="light"
        onClick={() => handleNavigate(entry.key)}
      >
        <FontAwesomeIcon icon={faFolderOpen} /> Go to folder
      </Button>
    ),
    [handleNavigate]
  );

  const placeholder = `Search under "${prefix || "root"}"…`;
  const emptyMessage =
    debounced.length === 0
      ? "Type to search."
      : isLoading
        ? "Searching…"
        : "No matches found.";

  return (
    <Modal
      show={show}
      onClose={onClose}
      title={`Search objects · ${bucketName}`}
      size="full"
    >
      <Input
        autoFocus
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      <ObjectListTable
        bucketName={bucketName}
        data={tableData}
        isLoading={isLoading}
        hasMore={hasMore}
        onQueryChange={onQueryChange}
        onReload={reload}
        menuTitle="Results"
        emptyMessage={emptyMessage}
        extraObjectActions={extraObjectActions}
      />
    </Modal>
  );
};

export default ObjectSearchModal;
