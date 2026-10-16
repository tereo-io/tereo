---
core: minor
---

`PARTITION_DDL_LOCK_TIMEOUT_MS` (default `5000`, 100–60000) sets how long creating or dropping a partition of the audit, webhook-delivery or notification tables waits for its table's lock before giving up until the next run. It was fixed at 5 seconds, which stays the default.
