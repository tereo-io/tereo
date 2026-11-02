---
core: minor
---

Multipart uploads honour `If-Match` and `If-None-Match`. Initiate checks them early and answers `412` before creating an upload; complete enforces them authoritatively in the commit transaction, and a `412` there leaves the upload open until it is aborted or expires.
