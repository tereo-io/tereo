---
"@tereo-io/sdk": major
---

The audit outbox validates entries like core: `changes` and `metadata` up to 64 KiB, ids as GUIDs. Docs cover the new event and bucket-permission limits.

Breaking changes:

- `FileServiceHealth` no longer has `version`.
