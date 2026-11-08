---
core: minor
---

Over-long request paths are refused first, with `414 uri_too_long`: a path over 8 KiB, counted in bytes as sent. Every route's longest legal path fits (an audit entity id or object key fully percent-encoded). The query string is not limited beyond Node's 200 KiB header limit. Trailing-slash trimming on request paths no longer takes time quadratic in a run of slashes, which an unauthenticated request could use to block the event loop.
