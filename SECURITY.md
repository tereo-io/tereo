# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's
[private vulnerability reporting](https://github.com/tereo-io/tereo/security/advisories/new),
not in a public issue, pull request or discussion.

Include what you can of:

- the affected package (`tereo`, the container image, or `@tereo-io/sdk`) and version
- what an attacker can do, and what they need first (a signed-in user, an app service's
  credentials, network access to core)
- the steps or a proof of concept that shows it

You will get an acknowledgement within a week. Once the issue is confirmed, a fix is prepared in
a private advisory, released, and then the advisory is published with credit to you, unless you
would rather not be named.

## Supported versions

Tereo is before 1.0, so only the latest release gets security fixes:

| Package | Supported |
|---------|-----------|
| `tereo` (`ghcr.io/tereo-io/tereo`) | The latest `0.x` release |
| `@tereo-io/sdk` | The latest `0.x` release |

## Not vulnerabilities

- **The development key-encryption key.** Outside production, core without a `CORE_KEK` encrypts
  its stored keys with a built-in key that is public by design, and logs a warning saying so.
  Production refuses to start without `CORE_KEK`.
- **Settings refused in production.** `NODE_ENV=development` disables the production checks on
  `PUBLIC_URL`, `TRUST_PROXY`, `CORS_ALLOWED_ORIGINS` and secure cookies
  ([configuration](packages/tereo/docs/configuration.md)). A finding that needs those checks
  turned off is out of scope.
- **The setup token.** Until the first admin exists, core logs a one-time setup token. Anyone who
  can read core's logs before setup can complete it.
