## 0.2.0 (2026-10-15)

### 🚀 Features

- The Helm chart takes `service.annotations`, for sticky sessions when running more than one API pod (socket.io's long-polling fallback needs every request of a session on one pod). API pods get a `preStop` delay (`preStopSleepSeconds`, default 5) so the ingress stops routing to a pod before it shuts down, with the grace period extended by the same amount. ([#6](https://github.com/tereo-io/tereo/pull/6))

### 🩹 Fixes

- The admin UI uses the Tereo mark: its favicons (now including an SVG favicon), home-screen and touch icons, and the mark beside the name in the top bar. ([#8](https://github.com/tereo-io/tereo/pull/8))

### ⚠️  Breaking Changes

- Client secrets must now use the `tereo_sk_` format (core-generated ones switch to it, and secrets supplied by a deploy must pass its strength rules); app services can no longer request core admin roles (`admin`, `platform_admin`, `*_admin`), only the roles marked requestable, named bare (`core/<name>` is refused); and core's own login client and clients with `consentRequired: false` no longer show the consent screen after a password login, though a `consentRequired: false` client asking for any `core:*` scope always gets it. ([#7](https://github.com/tereo-io/tereo/pull/7))

  A deploy can declare its app services and login clients in a provisioning file (`PROVISIONING_FILE`, or the chart's `provisioning` value). Core applies it at every start, all or nothing, with secrets read from the environment and access pre-approved; its rows are read-only through the admin API (`409 managed_by_provisioning`), except that a service's secret overlap can still be ended early. Login clients gain an admin-set `audience` and a `consentRequired` flag, `SETUP_TOKEN` lets first-boot setup run unattended, and `npm run cli -- generate-secret` makes a secret in the new format.

### ❤️ Thank You

- Aaron Leman

## 0.1.1 (2026-10-15)

### 🩹 Fixes

- Linted with ESLint 10. An SMTP host that fails to resolve now keeps the resolver's error as the `cause` of the one core logs; the delivery still records only "The SMTP host did not resolve". ([#1](https://github.com/tereo-io/tereo/pull/1))
- A Helm chart, `oci://ghcr.io/tereo-io/charts/tereo`, released with the image at the same version. It reads Postgres, Redis and `CORE_KEK` from a Secret you provide or one External Secrets builds, runs migrations as a pre-install and pre-upgrade hook, and refuses to render a configuration core would refuse at start. ([#2](https://github.com/tereo-io/tereo/pull/2))
- OpenTelemetry moves to `sdk-node` 0.223 and `auto-instrumentations-node` 0.81, which clears every moderate `npm audit` finding. ([#1](https://github.com/tereo-io/tereo/pull/1))
- The Prisma CLI in the image uses `mysql2` 3.24 and `deepmerge-ts` 8 in place of the versions Prisma pins, which carry open advisories. `npm audit` reports no vulnerabilities. ([#1](https://github.com/tereo-io/tereo/pull/1))
- `sharp` moves to 0.35, which brings a libvips with fixes for CVE-2026-33327, CVE-2026-33328, CVE-2026-35590 and CVE-2026-35591, and `dotenv` to 18. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Two concurrent first sign-ins with one email, through an invite or a domain, again end as one user and an `account_exists` for the other. Since Prisma 7.10 a unique violation names only its index, which the race handling did not read. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Background jobs run on BullMQ 6 and `ioredis` 6. Stopping a worker while Redis is unreachable still drops BullMQ's blocking connection rather than leaving it reconnecting. ([#1](https://github.com/tereo-io/tereo/pull/1))
- Dependencies updated within their ranges, among them Prisma 7.10, `multer` 2.4, `undici` 6.29, `socket.io` 4.8.4 and Vite 8.3, which clears the `npm audit` findings those ranges could fix. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ❤️ Thank You

- Aaron Leman