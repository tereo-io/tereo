---
core: patch
---

File blob storage goes through one internal interface (`utils/blobStore`), with disk as its only implementation. Nothing changes for the API, the SDK, configuration or the files on disk.
