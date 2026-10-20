---
core: patch
---

The admin UI uses `@kosmeo-ui/react` 1.0.1. Its bucket, object, permission, share and event-type lists pass a failed load's error on to the list, as the library's own lists do. Pressing Escape in a multi-select inside a dialog (such as a webhook endpoint's event types) now closes only the list, not the dialog and the form in it, and dialogs are announced by their title.
