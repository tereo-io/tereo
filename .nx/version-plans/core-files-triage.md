---
core: major
---

A triage of the file service. Bucket management follows an active grant: a bucket has an owner (`ownerId`, migration `bucket_owner`, backfilled from `createdBy`), who manages it only while holding a grant, and `PUT /v1/files/buckets/:name/owner` (`file-service.admin`) transfers it, emitting `file-service.bucket.owner-changed`. Presigned and archive URLs re-check their signer's access on every use, and a share stops serving once its creator is deactivated (`creator_inactive`). Removing an organization member revokes their grants on its buckets. Signed URLs answer HEAD without spending a capped share's nonce, spend it only once the body is ready, sign their filename, honour conditional requests and write access-log rows. Error responses drop download headers and are `no-store`. HEAD by key honours `versionId` and `thumbnail`; every download follows RFC 9110 preconditions; verified small-blob reads share a byte budget (`FILE_SERVICE_VERIFIED_READ_BUDGET_MB`, `FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS`, `503` when busy); an archive lists unreadable blobs in `MISSING_FILES.txt` instead of aborting. Idempotency records commit with the upload; content-blob refcounts carry a `CHECK (ref_count >= 0)` and orphan cleanup refuses a blob still referenced; staged multipart parts are bound to their upload and part number (migration `files_write_integrity`; parts staged before the deploy still complete); quota counts active multipart reservations and refuses early. Lifecycle `purgeSoftDeletedAfterDays: 0` purges, version expiry counts from when a version was replaced (migration `object_version_noncurrent_since`), and a `bucket-cleanup-reconcile` job releases deleted buckets whose cleanup never ran. Buckets of a service dropped from provisioning become deletable.

Breaking changes:

- A bucket owner whose grant was revoked no longer manages the bucket and cannot re-grant it; only `file-service.admin` can.
- Presigned and archive URLs stop working when their signer is deactivated or loses access; a `?filename=` not covered by the signature is ignored.
- Setting `deleteAfter` takes delete access; managing shares on a public bucket takes a grant.
- On a public bucket, callers without a grant no longer see deleted objects, non-current versions or `createdBy`.
- Weak `If-Match` tags never match; `If-None-Match` with tags is honoured on PUT.
- `file-service.objects.bulk-deleted` and `file-service.objects.versions.purged` fire once per batch, with `batchIndex` and no `truncated`.
- A missing archive's signed URL is `403`, not `404`; the loser of racing bucket deletes or an update to a deleted bucket gets `404`; `requestCost > maxTokens` is `400`.
- Part uploads racing a complete get `409 multipart_complete_in_progress`, after it `400 upload_not_active`; a part that fails its MD5 at complete is `422 part_integrity_mismatch`.
