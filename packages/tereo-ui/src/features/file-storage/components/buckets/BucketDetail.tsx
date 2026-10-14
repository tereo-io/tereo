import { PermissionManager } from "@/features/file-storage/components/permissions/sections/PermissionManager";
import ShareManager from "@/features/file-storage/components/shares/sections/ShareManager";
import ObjectTree from "@/features/file-storage/components/objects/sections/ObjectTree";
import PurgeNonCurrentVersionsButton from "./buttons/PurgeNonCurrentVersionsButton";
import useBucketPermissions from "../../api/buckets/useBucketPermissions";
import { useParams, useSearchParams } from "react-router-dom";
import EditBucketButton from "./buttons/EditBucketButton";
import BucketOriginBadges from "./BucketOriginBadges";
import useBucket from "../../api/buckets/useBucket";
import LifecycleTab from "./tabs/LifecycleTab";
import formatBytes from "@/utils/formatBytes";
import { useEffect, useState } from "react";
import { userLabel } from "@/lib/refs";
import { useAuth } from "@/lib/auth";
import CorsTab from "./tabs/CorsTab";
import "./styles.css";
import {
  canManageBucket,
  isBucketRetired,
} from "../../api/buckets/bucketOwnership";
import {
  Badge,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  Spinner,
  TabButton,
} from "@kosmeo-ui/react";

type Tab = "details" | "objects" | "permissions" | "shares";

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const isValidTab = (tab: string | null): tab is Tab => {
  return (
    tab === "details" ||
    tab === "objects" ||
    tab === "permissions" ||
    tab === "shares"
  );
};

export const BucketDetail = () => {
  const { hasPermission, user } = useAuth();
  const { bucketName } = useParams<{ bucketName: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: bucket, isLoading, refetch } = useBucket(bucketName!);
  const { data: permissions, isLoading: permissionsLoading } =
    useBucketPermissions(bucketName);

  const tabFromUrl = searchParams.get("tab");
  const initialTab = isValidTab(tabFromUrl) ? tabFromUrl : "objects";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const currentTab = searchParams.get("tab");
    if (currentTab !== activeTab) {
      setSearchParams({ tab: activeTab }, { replace: true });
    }
  }, [activeTab, searchParams, setSearchParams]);

  if (isLoading || permissionsLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner />
        </Centered>
      </Page>
    );
  }

  if (!bucket) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Bucket not found</EmptyState>
      </Page>
    );
  }
  if (!hasPermission("file-service.buckets.read")) return null;

  const canWrite = !!permissions?.canWrite;
  const canDelete = !!permissions?.canDelete;
  // `my-permissions` reports all-true for anyone with a grant, so it can't
  // tell who may change settings and grants on its own.
  const canManage = canManageBucket(
    bucket,
    user?.sub,
    hasPermission("file-service.admin")
  );
  // A retired bucket is read-only: core answers writes with 409.
  const retired = isBucketRetired(bucket);
  const canEditBucket =
    hasPermission("file-service.buckets.write") && canWrite && canManage;
  // Purging is a destructive cleanup of historical version rows; only offer it
  // on versioning-enabled buckets (otherwise there is no history to purge) and
  // require both the system-level delete permission and bucket-level delete.
  const canPurgeVersions =
    bucket.versioningEnabled &&
    hasPermission("file-service.objects.delete") &&
    canDelete;

  // In a versioning-enabled bucket `currentUsageBytes` counts history too
  // (blobs backing non-current versions stay on disk until a lifecycle policy
  // expires them). Surface a Current / Historical / Total split so the number
  // doesn't look "stuck" after a delete, without changing storage semantics.
  const usageRows: { label: string; value: string }[] =
    bucket.versioningEnabled && bucket.liveUsageBytes !== undefined
      ? (() => {
          const total = BigInt(bucket.currentUsageBytes);
          const live = BigInt(bucket.liveUsageBytes);
          const history = total > live ? total - live : 0n;
          return [
            { label: "Current usage", value: formatBytes(live.toString()) },
            {
              label: "Historical usage",
              value: formatBytes(history.toString()),
            },
            { label: "Total on disk", value: formatBytes(total.toString()) },
          ];
        })()
      : [
          {
            label: "Current usage",
            value: formatBytes(bucket.currentUsageBytes),
          },
        ];
  // Read-only admins should be able to view lifecycle/CORS config even though
  // they can't change it. The inner sections pass `disabled` down to each input
  // based on their own write check, so this gate is just for visibility.
  const canShowBucketManagement =
    hasPermission("file-service.buckets.read") && !!permissions?.canRead;

  return (
    <Page padded fillHeight>
      <div className="t-bucket-detail-tabs-header">
        {hasPermission("file-service.objects.read") && permissions?.canRead && (
          <TabButton
            active={activeTab === "objects"}
            onClick={() => setActiveTab("objects")}
          >
            Objects
          </TabButton>
        )}
        <TabButton
          active={activeTab === "details"}
          onClick={() => setActiveTab("details")}
        >
          Details
        </TabButton>
        {hasPermission("file-service.permissions.read") && canWrite && (
          <TabButton
            active={activeTab === "permissions"}
            onClick={() => setActiveTab("permissions")}
          >
            Permissions
          </TabButton>
        )}
        {hasPermission("file-service.shares.read") && permissions?.canRead && (
          <TabButton
            active={activeTab === "shares"}
            onClick={() => setActiveTab("shares")}
          >
            Shares
          </TabButton>
        )}
      </div>

      {hasPermission("file-service.objects.read") &&
        permissions?.canRead &&
        activeTab === "objects" && <ObjectTree />}
      {hasPermission("file-service.permissions.read") &&
        canWrite &&
        activeTab === "permissions" && (
          <PermissionManager bucket={bucket} canManage={canManage} />
        )}
      {hasPermission("file-service.shares.read") &&
        permissions?.canRead &&
        activeTab === "shares" && <ShareManager bucketName={bucketName!} />}
      {activeTab === "details" && (
        <Row>
          <Col>
            <ListCard
              listTitle={`Bucket: ${bucket.name}`}
              items={[
                ...(bucket.serviceId || bucket.retiredAt
                  ? [
                      {
                        label: "Declared by",
                        value: (
                          <>
                            {bucket.serviceName ?? bucket.serviceId ?? "—"}{" "}
                            <BucketOriginBadges bucket={bucket} />
                          </>
                        ),
                      },
                    ]
                  : []),
                {
                  label: "Description",
                  value: bucket.description || "No description",
                },
                {
                  label: "Policy",
                  value: (
                    <Badge
                      variant={
                        bucket.policy === "public" ? "warning" : "success"
                      }
                    >
                      {bucket.policy}
                    </Badge>
                  ),
                },
                ...usageRows,
                {
                  label: "Versioning",
                  value: (
                    <Badge
                      variant={bucket.versioningEnabled ? "success" : "warning"}
                    >
                      {bucket.versioningEnabled ? "enabled" : "disabled"}
                    </Badge>
                  ),
                },
                {
                  label: "Auto thumbnails",
                  value: (
                    <Badge
                      variant={bucket.autoThumbnails ? "success" : "warning"}
                    >
                      {bucket.autoThumbnails ? "enabled" : "disabled"}
                    </Badge>
                  ),
                },
                {
                  label: "Organization",
                  value: bucket.organization?.name ?? "None",
                },
                {
                  label: "Created by",
                  value: (
                    <span title={bucket.creator.email}>
                      {userLabel(bucket.creator)}
                    </span>
                  ),
                },
                { label: "Created", value: formatDate(bucket.createdAt) },
              ]}
              headerActions={
                <>
                  {canPurgeVersions && (
                    <PurgeNonCurrentVersionsButton
                      bucketName={bucket.name}
                      onPurge={refetch}
                    />
                  )}
                  {canEditBucket && (
                    <EditBucketButton bucket={bucket} onUpdate={refetch} />
                  )}
                </>
              }
            />
            {canShowBucketManagement && (
              <LifecycleTab
                bucketName={bucket.name}
                canWrite={canWrite && canManage && !retired}
                canDelete={canDelete && canManage}
              />
            )}
          </Col>
          {canShowBucketManagement && (
            <Col>
              <CorsTab bucket={bucket} canWrite={canWrite && canManage} />
            </Col>
          )}
        </Row>
      )}
    </Page>
  );
};
