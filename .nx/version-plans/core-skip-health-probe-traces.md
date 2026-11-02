---
core: patch
---

Health probes are no longer traced. `/health` and `/health/ready` requests (any case, with or without a query) are skipped by the HTTP instrumentation, and their Prisma queries with them, so they no longer start traces. Load balancers and the kubelet probe every few seconds per pod, and those traces were most of an idle install's span volume.
