import type { Bucket } from "../../api/buckets/types";
import { Badge } from "@kosmeo-ui/react";

/**
 * "service" for a bucket a service declared at registration, "retired" once
 * that service stops declaring it (read-only).
 */
const BucketOriginBadges = ({ bucket }: { bucket: Bucket }) => (
  <>
    {bucket.serviceId && (
      <Badge variant="primary">
        {bucket.serviceName ? `service: ${bucket.serviceName}` : "service"}
      </Badge>
    )}
    {bucket.retiredAt && <Badge variant="danger">retired</Badge>}
  </>
);

export default BucketOriginBadges;
