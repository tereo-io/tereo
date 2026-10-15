---
core: patch
---

A Helm chart, `oci://ghcr.io/tereo-io/charts/tereo`, released with the image at the same version. It reads Postgres, Redis and `CORE_KEK` from a Secret you provide or one External Secrets builds, runs migrations as a pre-install and pre-upgrade hook, and refuses to render a configuration core would refuse at start.
