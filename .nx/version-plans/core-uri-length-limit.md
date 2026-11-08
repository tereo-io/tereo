---
core: minor
---

Over-long request URLs are refused first, with `414 uri_too_long`: a path over 8 KiB or a whole URL over 32 KiB, counted in bytes as sent. Every route's longest legal URL fits (an audit entity id or object key fully percent-encoded, an `/oauth/authorize` request at every parameter's limit). Trailing-slash trimming on request paths no longer takes time quadratic in a run of slashes, which an unauthenticated request could use to block the event loop.
