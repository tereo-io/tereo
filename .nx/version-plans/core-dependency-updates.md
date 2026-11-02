---
core: patch
---

Dependency updates, with fixes for every advisory in core's runtime dependencies: multer 2.5 (a pending `fileFilter` after request teardown), body-parser 2.4 (trailing bytes after a compressed body), undici 6.29.1 (TLS options dropped by `Agent`, renegotiation and content-encoding denial of service), nodemailer 10.3.1 (address-parser recipient injection), follow-redirects, qs, fast-uri and systeminformation. OpenTelemetry moves to SDK 0.300 and resources 3. Installs resolve only versions published at least a day ago (`min-release-age=1` in `.npmrc`, npm 11.10 or later).
