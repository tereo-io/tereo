---
"@tereo-io/sdk": minor
---

The provisioning document types gain the `branding` block: `BrandingProvisioning` (`default` and per-client `clients`, keyed by `clientId`), `BrandingProfileProvisioning` (the text, `layout`, `footerLinks`, `applyToConsole` and image path slots, every one optional) and `BrandingColorVariable`, the list of colour variables a profile may set. `provisioning.schema.json` carries the block, limiting colour keys to those variables and footer link URLs to ones starting `https://` with no space or control character. The files types gain the bucket fields core now returns: `Bucket.coreManaged`, and `MyBucketPermissions.canRevokeShares`, `canPurgeVersions` and `coreManaged` (a core bucket is read-only through the files API, but for revoking and an admin's old-version purge); the test-mode mocks set them.
