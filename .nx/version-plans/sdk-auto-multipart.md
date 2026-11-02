---
"@tereo-io/sdk": minor
---

`core.files.uploadObject` now takes a `Buffer` or a `Readable`, and switches to a multipart upload on its own above `multipartThresholdBytes` (64 MiB by default), sending parts concurrently and aborting the upload if anything fails. Tune it with `createCoreClient({ files: { multipartThresholdBytes, partSizeBytes, partConcurrency } })`. `initiateMultipart` and `completeMultipart` accept `ifMatch` and `ifNoneMatch`.
