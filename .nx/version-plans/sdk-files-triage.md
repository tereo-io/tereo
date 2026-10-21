---
"@tereo-io/sdk": minor
---

`files.transferBucketOwnership(name, userId)` (`requests.files.transferBucketOwnership`) calls `PUT /v1/files/buckets/:name/owner`. `Bucket` gains `ownerId` and `owner`. `listObjects` takes `deleted: true` to list a versioned bucket's deleted objects. `ShareStatus` gains `creator_inactive`. A provisioning document's bucket `storageQuotaBytes` may be a digit string, capped at 1 TiB like the bucket API. Needs the `core` release with the bucket owner endpoint.
