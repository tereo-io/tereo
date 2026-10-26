import { faClockRotateLeft } from "@fortawesome/free-solid-svg-icons";
import ObjectVersionsModal from "../modals/ObjectVersionsModal";
import { formatDateTime } from "@/utils/formatDate";
import { useMemo, useState } from "react";
import useInfiniteDeletedObjects, {
  type DeletedObject,
} from "@/features/file-storage/api/objects/useInfiniteDeletedObjects";
import {
  IconButton,
  InfiniteScroll,
  RowActions,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

interface DeletedObjectsTableProps {
  bucketName: string;
  /** The folder being browsed: only deletions under it are listed. */
  prefix: string;
}

/**
 * A versioned bucket's deleted objects under the current folder. Each one's
 * history opens in the versions modal, where restoring a version undeletes
 * the object.
 */
const DeletedObjectsTable = ({
  bucketName,
  prefix,
}: DeletedObjectsTableProps) => {
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteDeletedObjects(bucketName, prefix);
  const [historyOf, setHistoryOf] = useState<DeletedObject | null>(null);

  const columns: TableColumn<DeletedObject>[] = useMemo(
    () => [
      {
        title: "Key",
        dataKey: "key",
        cellElement: (o) =>
          o.key.startsWith(prefix) ? o.key.slice(prefix.length) : o.key,
      },
      {
        title: "Deleted",
        dataKey: "deletedAt",
        width: "14rem",
        cellElement: (o) => formatDateTime(o.deletedAt),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (o) => (
          <RowActions align="center">
            <IconButton
              icon={faClockRotateLeft}
              title="Versions — restore one to undelete"
              size="sm"
              variant="light"
              onClick={() => setHistoryOf(o)}
            />
          </RowActions>
        ),
      },
    ],
    [prefix]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({ title: "Deleted objects" }),
    []
  );

  return (
    <>
      <InfiniteScroll<DeletedObject>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        onReload={reload}
        columns={columns}
        hideFilters
        hideSelectColumn
        emptyMessage="Nothing deleted in this folder."
      />
      {historyOf && (
        <ObjectVersionsModal
          bucketName={bucketName}
          objectId={historyOf.id}
          objectKey={historyOf.key}
          show
          onClose={() => setHistoryOf(null)}
        />
      )}
    </>
  );
};

export default DeletedObjectsTable;
