---
core: patch
---

Background jobs run on BullMQ 6 and `ioredis` 6. Stopping a worker while Redis is unreachable still drops BullMQ's blocking connection rather than leaving it reconnecting.
