---
core: patch
---

Admin UI polish (#37). Notification log entries (`GET /v1/admin/notifications` and `GET /v1/admin/notifications/{id}`) embed `sender` (`{ id, email, name }`) next to `senderUserId`, and the log shows the sender's name or email instead of a truncated ID. The log has order (newest or oldest first) and page-size controls, and its statuses are title case. Dates use one formatter app-wide (`Oct 22, 2026`, with the time on detail pages, and seconds in the audit log). Toasts follow the light or dark theme. The notification log and connections pages have an `<h1>`.
