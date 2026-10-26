import useInfiniteBuckets from "../../api/buckets/useInfiniteBuckets";
import { canDeleteBucket } from "../../api/buckets/bucketOwnership";
import DeleteBucketButton from "./buttons/DeleteBucketButton";
import CreateBucketModal from "./modals/CreateBucketModal";
import BucketOriginBadges from "./BucketOriginBadges";
import type { Bucket } from "../../api/buckets/types";
import { Link, useNavigate } from "react-router-dom";
import formatBytes from "@/utils/formatBytes";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  Badge,
  InfiniteScroll,
  Page,
  TableCellLink,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

export const BucketList = () => {
  const navigate = useNavigate();
  const { hasPermission, user } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteBuckets();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<Bucket>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (b) => (
          <>
            <TableCellLink as={Link} to={`/file-storage/buckets/${b.name}`}>
              {b.name}
            </TableCellLink>{" "}
            <BucketOriginBadges bucket={b} />
          </>
        ),
      },
      {
        title: "Description",
        dataKey: "description",
        cellElement: (b) => b.description || "-",
      },
      {
        title: "Policy",
        dataKey: "policy",
        width: "8rem",
        align: "center",
        cellElement: (bucket) => (
          <Badge variant={bucket.policy === "public" ? "warning" : "success"}>
            {bucket.policy}
          </Badge>
        ),
      },
      {
        title: "Usage",
        dataKey: "currentUsageBytes",
        width: "10rem",
        cellElement: (bucket) => formatBytes(bucket.currentUsageBytes),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (bucket) => {
          if (!hasPermission("file-service.buckets.delete")) return null;
          const isAdmin = hasPermission("file-service.admin");
          if (!canDeleteBucket(bucket, user?.sub, isAdmin)) return null;
          return <DeleteBucketButton bucket={bucket} onDelete={reload} />;
        },
      },
    ],
    [hasPermission, reload, user?.sub]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Buckets",
      filters: [
        {
          type: "SEARCH",
          title: "Name",
          dataKey: "name",
        },
        {
          type: "SEARCH",
          title: "Description",
          dataKey: "description",
        },
        {
          type: "SELECT",
          title: "Policy",
          dataKey: "policy",
          options: [
            { id: "public", name: "Public", selected: false },
            { id: "private", name: "Private", selected: false },
          ],
        },
        {
          type: "RANGE",
          title: "Usage",
          dataKey: "currentUsageBytes",
          rangeType: "NUMBER",
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "name", displayName: "Name", selected: true },
          {
            dataKey: "description",
            displayName: "Description",
            selected: false,
          },
          { dataKey: "policy", displayName: "Policy", selected: false },
          {
            dataKey: "currentUsageBytes",
            displayName: "Usage",
            selected: false,
          },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  if (!hasPermission("file-service.buckets.read")) return null;
  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<Bucket>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("file-service.buckets.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(b) => navigate(`/file-storage/buckets/${b.name}`)}
        hideSelectColumn
      />
      <CreateBucketModal
        show={showCreateModal}
        onCreate={(bucket) => {
          setShowCreateModal(false);
          navigate(`/file-storage/buckets/${bucket.name}`);
        }}
        onClose={() => setShowCreateModal(false)}
      />
    </Page>
  );
};
