# Auth area

The auth area of tereo, mounted at the root of the service (`http://localhost:4001`):
OAuth 2.0 Authorization Server and OpenID Connect Provider — authorization code + client credentials + refresh token grants, PKCE S256, token introspection/revocation, TOTP 2FA, RBAC, organizations, and real-time WebSocket events. First-boot setup (`/v1/setup`) and `/v1/admin/services` are root-mounted beside it; services are declared in provisioning documents ([provisioning.md](provisioning.md), [registry.md](registry.md)).

## Structure

```
src/
├── routes/
│   ├── oauth/          # OAuth 2.0/OIDC endpoints (authorize, token, consent, org-select, totp, etc.)
│   ├── account/        # Self-service user endpoints
│   ├── admin/          # Admin management (users, roles, permissions, clients, orgs, settings, services)
│   └── well-known/     # Discovery endpoints
├── middleware/         # auth.ts (requireAuth + requirePermission; sets OTel span attrs enduser.id, enduser.role, tereo.org.id, tereo.oauth.client_id, tereo.permission.required), rateLimit/
├── websocket/          # Socket.io server (emitters/, handlers/, middleware/)
└── utils/
    ├── db/             # Database access layer
    ├── tokens.ts       # JWT generation/verification (RS256)
    ├── totp.ts         # TOTP 2FA (AES-256-GCM encrypted secrets)
    ├── cursor.ts       # HMAC-signed list cursors (admin pagination)
    └── crypto.ts       # Cryptographic utilities
```

## Who may call core's API

Core's own resource routes — `/v1/account`, `/v1/admin`, `/v1/files`, `/v1/audit`, `/v1/webhooks`,
`/v1/notifications` and the `/ws` socket — admit a bearer token by the client it was issued to (`utils/coreAccess.ts`,
applied in `requireAuth` from what `checkAccessToken` resolves, so the socket and every router
agree):

| Token issued to                                                                    | Admitted                         | Rights                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Core's UI (`tereo-ui`, `isFirstPartyClient`)                                       | everywhere                       | the user's live permissions                            |
| A service (a client with a `core.services` row, or any `client_credentials` token) | everywhere                       | the account's live permissions                         |
| Any other client, granted core API scopes — its token's `aud` then includes `core` | the areas its scopes name        | the live permissions, cut down to the scopes' ceilings |
| Any other client, without core API scopes                                          | nowhere: **401 `invalid_token`** | —                                                      |

A delegated token that reaches an area its scopes do not name gets **403 `insufficient_scope`**,
with a `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` challenge naming the scopes
that would. Inside an area, permissions are checked as always, against the cut-down set.

Rights are always read live, never from the token: access tokens carry no `permissions` claim,
which would grow with every role and go stale the moment one is revoked. A service outside core
reads them from `/oauth/introspect` (the SDK's `requireAuth`) or asks `/oauth/check-permission`.

Core's API scopes (`definitions/coreScopes.ts`; seeded into `auth.scopes`, advertised in
discovery) are per area, each with a read-only variant:

| Scope                                  | Area                            | Ceiling                                                                                                  |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `core:account`                         | `/v1/account`, `/ws`            | — (the user's own account)                                                                               |
| `core:admin` / `core:admin.read`       | `/v1/admin`                     | `users`, `roles`, `permissions`, `clients`, `settings`, `organizations`, `services` — `.admin` / `.read` |
| `core:files` / `core:files.read`       | `/v1/files`                     | `file-service.admin` / the four `file-service.*.read`                                                    |
| `core:audit` / `core:audit.read`       | `/v1/audit`                     | `audit-logs.admin` / `audit-logs.read`                                                                   |
| `core:webhooks` / `core:webhooks.read` | `/v1/webhooks`                  | `webhooks.admin` / `webhooks.read`, `webhooks.event-types.read`                                          |
| `core:events`                          | `/ws`                           | — (the socket only: permission changes and its own session's end, nothing else)                          |
| `core:organizations`                   | `GET /v1/account/organizations` | `organizations.support-access` ([Support access](#support-access))                                       |

`/v1/notifications` has no scope: only core's UI and services reach it.

A ceiling caps, it never grants: the token holds
a permission only if the user holds it _and_ a ceiling covers it. A user's organization member role
(owner/admin/member), which authorizes organization routes without a permission, is capped the same
way (`requireOrgRole` checks the ceiling). An admin opts a client in by adding core scopes to its
`scopes` (`PATCH /v1/admin/clients/:id`); the user then approves them on the consent screen. Nothing
else changes: the UI and services need no scope, and `openid`/`profile`/`email`/`offline_access`
keep their OIDC meaning.

`core:account` admits `/v1/account` and `/ws`; `core:events` admits the socket alone, and
`core:organizations` the organizations list alone, so an app can offer an organization picker, or
live permission updates, without being given the user's account. The 403's message names the request
path (`This token's scopes do not reach /v1/account/me; it needs one of: core:account`), and the
`WWW-Authenticate` challenge lists the scopes of every area that would admit it.

### Trusted core scopes

A login client normally sends the user through the consent screen for every `core:*` scope it
requests. A **provisioned** client with `consentRequired: false` and `trustedCoreScopes` skips it for
those scopes, `prompt=none` included; a request for any `core:*` scope outside the list still
asks. Each trusted scope must be a core scope in the client's `scopes`, never `core:admin` or
`core:admin.read`, and the field is settable only through
[provisioning](provisioning.md#clients). Trusting a scope skips the screen, not the ceiling: the
token still holds only what the user holds and the scope's ceiling covers.

### Account organizations

`GET /v1/account/organizations` (`core:account` or `core:organizations`) lists the caller's active
organizations, 50 per page by default, sorted by `name` or `slug` (default `name`, ascending), as
`{ id, name, slug, memberRole, member }`. `search` (2 to 100 characters, case-insensitive on name
and slug) filters them. Archived and inactive organizations never appear. For a holder of
`organizations.support-access` whose token's ceiling covers it (`core:organizations`, or core's own UI), a search also returns non-member organizations (`member: false`,
`memberRole: null`); without `search`, the list is memberships only.

### Support access

`organizations.support-access` is a global-only permission (not org-assignable) that lets a
person sign in **into any active, unarchived organization they are not a member of**, to help its
users. Holders are whoever has a role carrying `organizations.support-access` directly, and root
`admin`, which includes every permission, so platform admins have it too. It works at every point that picks an
organization (`org_id` on `/oauth/authorize`, the org picker, a login's organization hint) and when
a code or refresh token is exchanged, so removing the permission ends the grant at the next refresh
(`invalid_grant`, revoked as for a lost membership). The resulting token names the organization,
but its permissions are the person's **global** ones: the visit grants no organization role.

Each time a code is issued for a non-member organization core writes an audit entry (entity
`Organization`, under that organization: action `LOGIN`, `metadata.action` `support_access`,
`client_id`, `sid`) and emits the event `auth.organization.support-access`
(`{ userId, organizationId, clientId }`, read with `organizations.read`) in the same transaction, so
the organization's webhooks and audit log show who came in. A refresh writes nothing more, nor
does a silent re-issue (`prompt=none`) in the organization the SSO session already holds. Members
switching into their own organization write neither; nor does someone whose permission was removed
before the code was issued.

### Sign-in audit

A login writes one `LOGIN` entry (`User`), when its code is issued, so after any second factor: a
first factor alone, or a TOTP step abandoned, writes none. Its metadata has `client_id`, `sid` (the
SSO session) and `auth_methods`, plus `provider` (the identity provider's slug) for a provider
login — carried through the TOTP, org-select and consent steps (`provider` on their rows). A grant
approved on the consent page also writes it, continued SSO session or not, with `consent: true`,
`fresh_login` and the `scopes` approved; a silent re-issue without consent writes nothing. A
password login in a browser that still holds another user's SSO session ends that session and its
token families, recorded for that user as a revoke by core (`UPDATE`, actor the system user,
`metadata.action` `sessions_revoked`) with an `auth.user.sessions-revoked` event.

Outside core's resource routes:

- `/oauth/userinfo` is the OIDC endpoint every relying party uses: any active user access token
  carrying `openid` (otherwise 403 `insufficient_scope` with a `scope="openid"` challenge), with
  `profile`/`email` claims by scope. `roles`, `permissions` and `organizations` — core's
  authorization — are included only for a token that is not `none` above (the UI, a service's
  client, or a core API scope); any other relying party gets the OIDC claims (and `org_id`/`org_name`
  for the token's organization) without them. A `delegated` token is told what `requireAuth` would
  let it use: `permissions` cut down to its scopes' ceilings, `roles` empty (a role is not capped;
  its permissions are), and `organizations` only with `core:account` or `core:organizations`, the
  scopes that list them at `/v1/account/organizations` (otherwise empty).
- `/oauth/introspect` answers app services (the token's own client, or a service in its audience),
  and only confidential clients, by HTTP Basic: a public client's `client_id` authenticates nothing,
  so it is 401 `invalid_client` (discovery lists `client_secret_basic` alone).
  `sub` is the token's own: the user's id, or a client_credentials token's `client_id`. `user_id`
  names the user the token acts as — the user, or the client's service-account user — so an app
  can record either kind as an actor in `auth.users`.
  It reports `permissions` as the user's live permissions — for a `delegated` token (a third-party
  client's, with core API scopes) cut down to its scopes' ceilings as `requireAuth` cuts them, so an
  app is never told more than core itself would let that token do. A third-party token without core
  scopes (`none`) is reported to a service in its audience with the user's live permissions: core's
  ceilings come from core API scopes, and an app enforces its own; whether it honours that token for
  its own API is the app's decision, which `scope` and `aud` in the response inform. A client that is
  not a service's, introspecting its own token whose access is `none`, is not told them, as at
  userinfo.
- `/oauth/check-permission` authenticates a confidential client, not a token. A client of an
  organization may only ask about that organization's members, and is answered in it;
  `organization_id`, if given, must be the client's; a non-member and an unknown user get the same 403. An organization-bound
  [integration](integrations.md) is such a client, answered for its organization's members. A
  client of no organization must be a service's (a platform integration is refused): it is
  answered from the user's global roles only and may not name an organization; an unknown user is a
  403 like every other refusal. Any other client — a login client created under
  `/v1/admin/clients` — is refused, so it cannot read any user's global permissions. Every refusal is
  403, decided before the user is looked up. A deactivated user holds nothing, and neither does any
  member of an inactive or archived organization in it: every check answers `false`.
- `/oauth/introspect`, `/oauth/revoke` and `/oauth/check-permission` refuse a deactivated service's
  or integration's secret (401 `invalid_client`), as `/oauth/token` refuses to mint for it.

## Access tokens

Access tokens are RS256 JWTs with the header `typ: at+jwt` (RFC 9068), carrying `jti`, `client_id`,
`sub` and `scope`. Verification requires both the typ and that shape, so an ID token (typ `JWT`, no
`jti`/`client_id`/`scope`) never passes as an access token. A token typed `JWT` from before the
change is accepted only if its `iat` is before the verifying process started (plus five minutes for
the old replicas of a rolling deploy), which bounds the overlap to one access-token lifetime. This
compatibility case is temporary.

A refresh token is issued at the code exchange only to a client with the `refresh_token` grant
type. The UI's client always has it.

A refresh may narrow the token's scope (`scope`, RFC 6749 section 6), never widen it. A scope
removed from the client since the grant is dropped silently, from the new access token and from
the rotated refresh token's grant.

Refresh tokens rotate on every use: the spent one is revoked with `rotated_at` set
(`rotateIfActive`). Presenting a revoked token is `400 invalid_grant` in every case, but what else
happens depends on how it was revoked:

- **Ended, not rotated** (`rotated_at` empty: `/oauth/revoke`, logout, an admin or a session end) —
  nothing more. No reuse is logged and the family is left as whoever ended the token left it.
- **Rotated within the last 5 s** (`REUSE_GRACE_MS`), **its successor unused** — taken for two tabs
  or a retry refreshing with the same token at once. The family, and the successor the other request
  received, stay valid, and the `trt_{client_id}` cookie is not cleared (the winning request has
  already replaced it). If any token of the family has been rotated since this one was
  (`familyRotatedSince`) — the successor already spent, as by a thief who rotated a stolen token
  first and kept going — it is reuse even inside the grace.
- **Otherwise** (rotated earlier, or its successor spent) — reuse (OAuth 2.0 Security BCP): the whole family, refresh tokens and their
  access tokens, is revoked and `refresh_token_reuse` is logged.

A replayed authorization code revokes its family the same way (`auth_code_reuse`). Either reuse is
also recorded in the revoking transaction, as core's: an audit entry (`User`, action `UPDATE`, actor
the system user, `metadata.action` `token_reuse_detected`, with `credential`
(`authorization_code` or `refresh_token`), `clientId`, `authCodeId`, the revoked `sessionIds` and
the `revokedAccessTokens` / `revokedRefreshTokens` counts) — written even when the family was
already dead, since the replay is the finding — and, when anything was revoked, an
`auth.user.sessions-revoked` event.

Revoking a refresh token at `/oauth/revoke` ends its whole family, a successor rotated from it
included, and the SSO session it was issued under (`endSession`), under the same session-end lock
a refresh takes, so a refresh racing the revocation cannot leave a live successor. It is the user's
logout: a `LOGOUT` audit entry (`metadata.action` `sessions_revoked`, `method` `revoke`, the
`sessionIds` and `ssoSessionIds` ended) and an `auth.user.sessions-revoked` event, in that
transaction; a token already revoked, with nothing else to end, records nothing. Revoking an access
token revokes it and writes a `LOGOUT` entry (`metadata.action` `token_revoked`, `tokenType`
`access_token`, `jti`, `clientId`) in one transaction, again only when it was live.

A refresh token issued under an organization is refused (`invalid_grant`) and its family revoked once
the user is no longer a member or the organization is inactive or archived. Deactivating an
organization revokes its refresh and access tokens and SSO sessions in the deactivating transaction,
under the session-end lock on every member and token holder, and by organization rather than by a
list read beforehand, so a refresh racing it cannot leave a live successor.

## The admin UI's login client

`tereo-ui` is public, with the `authorization_code` and `refresh_token` grants
(`loginClientConfig`). The seed creates it, and core sets those fields again on every start
(`utils/loginClient.ts`), so a change of `UI_BASE_URL` takes effect with the next start.

Its redirect URIs (`loginClientRedirectUris`): in production, exactly `${UI_BASE_URL}/callback`.
Elsewhere that callback is added first and the other loopback callbacks already registered
(`localhost`, `127.0.0.1`, `[::1]`) are kept, so a compose core (UI at `:4001`) and an
`npm run dev` core (UI at `:4000`) sharing one database can both log in. A non-loopback URI is
dropped even in development: the client skips the consent screen, so a stale callback on a host
nobody controls would receive its codes. `PATCH /v1/admin/clients/:id` refuses to change its `redirectUris`,
`grantTypes`, `clientType`, `consentRequired` or `audience` with 409; its name, scopes and post-logout URIs stay editable, and it
cannot be deleted.

**Audience and consent.** A login client carries two admin-set fields. `audience` lists the slugs
of services its tokens may name: each must be an existing service other than core
(`422 invalid_audience`), and changing it needs `services.approve` as well as `clients.write`.
`consentRequired` (default `true`) says whether a user approves the app on the consent screen after
signing in. With `false`, the consent step is skipped everywhere a consent session would be made:
silent authorize, org switch, and after a password login (and its TOTP step) or the org picker —
but only for a request with no `core:*` scope and without `prompt=consent`. A request for any core scope always shows the
consent screen (and `prompt=none` gets `consent_required`), since those scopes act in core's API as
the user. Core's own login client always skips it, so the admin UI shows no consent screen after a
password login. The user still signs in, and the client still gets only the scopes it is registered
for. Core's own login client never asks and refuses a change to either field. Both
fields can come from the [provisioning file](provisioning.md), whose clients are read-only here
(`409 managed_by_provisioning`).

**Listing clients.** With `clients.read`, `GET /v1/admin/clients` lists the clients the caller owns,
and `GET /v1/admin/clients/:id` reads one of them. With `clients.admin` as well, both show every
client — services', organizations' and login clients alike — with their metadata (name, type,
redirect URIs, scopes, grant types, audience, owner, organization, service). No secret is ever
returned; a client secret is shown once, when it is created or regenerated.

## Requested authentication class (`acr_values`)

Discovery advertises `urn:auth-service:pwd` and `urn:auth-service:mfa`. An authorize request whose
`acr_values` names `urn:auth-service:mfa` and not `urn:auth-service:pwd` must end in a login with a
second factor (TOTP or a recovery code); core treats the value as required, not a preference:

- A password login by a user with TOTP goes to the 2FA step, whatever the role and policy say.
- A user without TOTP is sent through 2FA setup (the setup grant keeps `acr_values`, and the UI
  restarts the authorize request afterwards). If the `totpPolicy` is `disabled`, enrolment is
  impossible and the login ends at the client's redirect URI with
  `error=unmet_authentication_requirements`.
- `prompt=none` over an SSO session whose login had no second factor answers
  `error=interaction_required`; an `org_id` switch over one falls through to the password login.
- No code is ever issued for such a request without a second factor (`issueAuthorizationCode`
  refuses with `interaction_required`).

The ID token's `acr` is `urn:auth-service:mfa` exactly when the login used one (`amr` has `otp` or
`recovery`), and `urn:auth-service:pwd` otherwise.

## Sign in with an identity provider

Users can sign in through an upstream OpenID Connect provider (Google, Okta, Entra, any OIDC
issuer) instead of a password. Core stays the identity provider for its apps: it is an OIDC
_client_ of the upstream for one step only, proving who the user is. Everything after that step —
TOTP, organization selection, consent, code and token issue — is the password flow. Apps and the SDK
do not change; they still send users to `/oauth/authorize` and receive core-signed tokens.

Providers, domains and their default roles are managed under `/v1/admin/identity-providers`
(permissions `identity-providers.read` / `identity-providers.write`, global only: a provider creates
users and assigns roles) and in the admin UI under Identity providers. Delegated tokens cannot reach
these routes: no `core:admin` scope ceiling covers `identity-providers`, so only the admin UI and
service accounts holding the permission can manage providers.

### Google setup checklist

In order, for a first provider (here `google`, at `https://core.example.com`):

1. **Create the OAuth client in Google Cloud.** APIs & Services, Credentials, _Create credentials_,
   OAuth client ID, type _Web application_. Set the authorized redirect URI to the provider's
   `callbackUrl`, which is predictable from the slug you will choose:
   `https://core.example.com/oauth/upstream/google/callback`. Copy the client ID and secret.
2. **Create the provider in core**, in the admin UI (Identity providers) or with
   `POST /v1/admin/identity-providers` (`identity-providers.write`):

   ```json
   {
     "slug": "google",
     "displayName": "Google",
     "kind": "oidc",
     "issuer": "https://accounts.google.com",
     "clientId": "<google-client-id>.apps.googleusercontent.com",
     "clientSecret": "<google-client-secret>",
     "countsAsMfa": false
   }
   ```

3. **Copy `callbackUrl` from the response into Google** and make sure it matches the redirect URI
   from step 1 exactly (scheme, host, path, no trailing slash). A mismatch fails at Google with
   `redirect_uri_mismatch`.
4. **Add a domain** with its organization, flags and default roles
   (`POST /v1/admin/identity-providers/{id}/domains`):

   ```json
   {
     "domain": "example.com",
     "organizationId": "<organization-uuid>",
     "autoAccept": true,
     "ssoOnly": false,
     "roleIds": ["<org-assignable-role-uuid>"]
   }
   ```

   Leave `ssoOnly` off until sign-in works, and see the `hd` rule below for who can match.

5. **Check it.** The "Google" button should appear on the login page
   (`GET /oauth/upstream/providers` lists it), and a test login with an `@example.com` Workspace
   account should create the user in the organization with the default roles. If the button is
   missing, the provider is inactive; if the login ends on `/login?error=…`, see _Errors_.

### Register core at the provider

Whatever the provider, you register one redirect (callback) URL at it, and the admin API returns it
as `callbackUrl` when you create the provider:

```
${PUBLIC_URL}/oauth/upstream/<slug>/callback
```

`<slug>` is the provider's slug (`[a-z0-9-]`, up to 50 characters; `providers` is reserved). A slug
cannot change once any user has linked an identity, because the callback URL is registered at the
provider.

**Google.** In Google Cloud console, APIs & Services, Credentials: create an OAuth client ID of type
_Web application_, add the callback URL above as an authorized redirect URI, and copy the client ID
and secret. Configure the consent screen as _Internal_ if only your Workspace domain should sign in.
Then add the provider in core with issuer `https://accounts.google.com`.

**Other OIDC providers.** Register a confidential web client with the authorization code flow, the
callback URL above, and the `openid`, `email` and `profile` scopes; give core the issuer URL, client
ID and secret. The issuer must match the `issuer` in the provider's
`/.well-known/openid-configuration` exactly, must use https, and the provider must support
`response_type=code` and PKCE `S256`. Core checks all of this when you save the provider. For
**Entra**, use the single-tenant issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`; the
multi-tenant issuer (`/common`, `/organizations`) has no fixed issuer and is not supported. Entra does
not send `email_verified` by default, so for Entra invites, auto-accept and the forced link of an
SSO-only domain all answer `email_unverified` unless a verified-email claim is configured for the
app registration; Entra users can still link from the account page, which checks no email. Do not
turn on SSO-only for an Entra domain unless that claim is set. (For any provider, an admin should
link their own account from the account page before turning on SSO-only for their own domain.)
Entra's `sub` is also pairwise per app registration, so changing an Entra provider's `clientId`
breaks every link to it, as an issuer change would (below).

Issuers that are private, loopback or plain `http` are refused (core fetches admin-typed URLs through
its SSRF guard) unless `OIDC_ALLOW_PRIVATE_ISSUERS` is set, which is for tests and local development
only and is refused in production ([configuration.md](configuration.md)).

### Add a provider

`POST /v1/admin/identity-providers` (or the admin UI) takes `slug`, `displayName` (the login button's
label), `kind` (`oidc`, the only kind), `issuer`, `clientId`, `clientSecret`, and optionally `scopes`
(default `openid email profile`; must include `openid`) and `countsAsMfa`. The client secret is
sealed at rest under core's key and never returned; `PATCH` with the field omitted keeps it, but a
changed `issuer` or `clientId` needs a new `clientSecret` in the same request (400
`client_secret_required`), so the stored secret is never sent to an endpoint it was not issued
for. Create
and edit contact the issuer, so an unreachable or inconsistent issuer is a 400
`provider_unreachable` or `invalid_provider_config`. A new provider is active and appears on the
login page (`GET /oauth/upstream/providers`). `POST …/deactivate` hides it and refuses new
sign-ins; it is refused with 409 `sso_only_domain` while any of its domains is SSO-only.
`POST …/activate` re-checks the issuer. Providers cannot be deleted, only deactivated.

Once any user has linked an identity, `PATCH` refuses a new `slug` with 409 `slug_in_use` and a new
`issuer` with 409 `issuer_in_use`: a `sub` is unique only within its issuer, so under another issuer
the same `sub` may be another person, and every existing link would point at them. To move to a new
issuer, add a second provider and have users link it. Core cannot detect the same problem for a
`clientId` change at a provider whose `sub` is pairwise per client (Entra): don't change it once
users have linked. A new `issuer` is also refused, with 409 `provider_has_invites`, while an
unexpired identity invite names the provider: the invite would link whoever the new issuer vouches
for. Withdraw the invites first.

### Domains

A domain belongs to exactly one provider, globally (409 `domain_taken` otherwise). Each domain maps
to **one organization** and a set of **default roles** in it, and has two independent flags:

| Flag         | Effect                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoAccept` | A first sign-in with a verified email at this domain **creates the user**: no password, name from the claims, `member` of the domain's organization, the default roles assigned there, the identity linked. |
| `ssoOnly`    | The domain's provider is the only way in: password sign-in, and sign-in or linking through any other provider, is refused for its users.                                                                    |

They combine freely: "staff must use Google, and nobody joins automatically" is `ssoOnly` without
`autoAccept`. Default roles must be roles assignable within an organization, and the admin setting
them must be able to grant them, as when assigning roles to a user. Domains are managed at
`/v1/admin/identity-providers/{id}/domains`; `PATCH` changes only the fields sent, and `roleIds`
replaces the set (roles the domain already hands out skip the grant check, except when the `PATCH`
moves the domain to another organization: then every role it will hand out there, sent or kept, is
checked against that organization). Setting `ssoOnly: true` (on create or `PATCH`) is refused with 409
`provider_inactive` while the provider is deactivated, since its users would have no way in.
Deleting a custom role removes it from every domain's default roles. Each create, `PATCH` and delete
is audited and emits `auth.identity-provider.domain-created`, `-updated` or `-deleted` in its
transaction.

**`ssoOnly` hands the domain's accounts to the provider.** The next password sign-in of an existing
user at an SSO-only domain is force-linked to the provider and the password dropped (see _Linking
from the account page and SSO-only domains_), so whoever controls the provider's issuer and client
gets those accounts. `identity-providers.write` bounds nothing about those accounts, so only a
caller holding `admin` through a global role may make a domain SSO-only (on create or `PATCH`),
change the `domain` of an SSO-only one, turn `ssoOnly` off or delete an SSO-only domain (the last
two reopen the accounts to passwords), or change the `issuer` or `clientId` of a provider that has
an SSO-only domain; 403 otherwise. The checks run under the provider's row lock, which every domain
write takes.

A domain becoming SSO-only (created with it, `PATCH`ed to it, or an SSO-only domain renamed) closes
every other provider to its users, so once the change commits core enqueues a sweep
(`jobs/ssoOnlySessionSweep.ts`, named by the domain and its `updatedAt`) that ends all sessions of
each person at the domain who holds an identity at another provider (`endUserSessions`, one
transaction per user), audited and emitted as an admin session revoke (`sessions_revoked`,
`auth.user.sessions-revoked`). The domain's own provider's users and password users keep theirs; the
latter are force-linked at their next password sign-in. The sweep reads the domain as it is when it
runs, and does nothing once the domain is no longer SSO-only. A failure for one user is logged and
the sweep goes on to the next; the job then fails and is retried (10 attempts, exponential backoff
from 10s) for the users that failed only, since ending a user's sessions again would also end the SSO
sessions they have started since. When the job cannot be enqueued (Redis unreachable) the sweep runs
in the request instead, once.

A domain's `autoAccept` only matches the provider that owns the domain. A user with a matching
email who already exists is never signed in by it: see _No matching by email_ below.

### Google: the `hd` rule and gmail.com

Google marks a consumer account's email verified even when it uses a Workspace address. So for the
issuer `https://accounts.google.com`, a domain match (auto-accept or invite) also requires the `hd`
(hosted domain) claim to equal the email's domain. A consumer account using `you@example.com` carries
no `hd` and cannot claim `example.com`. For the same reason `gmail.com` and `googlemail.com` addresses, which
never carry `hd`, cannot be auto-accepted: those users can arrive only by **invite**.

### No matching by email

A provider identity (the pair of provider and the provider's stable `sub`) is **never matched to an
existing account by email**. A first sign-in lands in exactly one of three ways, tried in order:

1. The identity is already linked: it signs in that user, unless the user's email domain is SSO-only
   for another provider (below).
2. An unexpired **invite** exists for that provider, the invited user's email equals the provider's
   verified email (and `hd`, for Google): the invite is claimed, once, and the identity linked.
3. The email's domain is an `autoAccept` domain of this provider and no account has that email: a new
   user is created. If an account already has the email, the sign-in is refused with
   `account_exists`.

Otherwise it is refused with `no_account`. This is deliberate: a provider that lets people choose
unverified or recycled email addresses must not be able to take over a core account. A user links a
provider to an existing account only from the account page while signed in, or through an invite.
The user's email in core is not updated from the provider.

### Invites

A guest cannot be invited (400 `user_not_invitable`) or linked to a provider until promoted
([Guest users](#guest-users)).

An admin creates a user without a password (`POST /v1/admin/users` takes an optional `password`; the
user reads `hasPassword: false`) and issues an invite for a provider with
`POST /v1/admin/users/{id}/identity-invites` (`{ providerId }`). The first sign-in with that provider
whose verified email matches the user's claims the invite, once. Invites last 7 days, issuing again
for the same provider replaces the old one and restarts the 7 days, and one is removed when the user
links that provider another way. `GET /v1/admin/users/{id}/identities` lists the user's identities and
outstanding invites (an expired one is listed until the hourly cleanup removes it; check
`expiresAt`), and `DELETE …/identity-invites/{providerId}` withdraws one. An invite at another
provider than the one an SSO-only domain names, for a user at that domain, is refused with 409
`sso_required`, as linking it from the account page is: claiming it could never succeed. Changing a user's email
withdraws all of their outstanding invites, because an invite is matched by email and must not
follow the account to an address the issuing admin never saw. Core sends no email: tell the user to
"Sign in with <provider>". Issuing and withdrawing an invite are audited and emit
`auth.user.identity-invite-created` and `auth.user.identity-invite-withdrawn` in the same transaction.

An invite is a new way into the account, so it is held to the same rule as a password reset: the
caller must hold every permission the user holds (see _TOTP_ below). Issuing is refused for the system user and service accounts, with `provider_inactive`
or `unknown_provider` (400) for a deactivated or unknown provider, and with `already_linked` (409) when
the user already has an identity there.

A user without a password cannot set one themselves: `POST /v1/account/password` answers 400
`no_password`. An admin sets one with `PATCH /v1/admin/users/{id}` (`password`).

### Linking from the account page and SSO-only domains

A signed-in user connects a provider from the account page: the UI calls `POST /v1/account/identities`
with the provider's `slug`, which sets the `upstream_auth` cookie and answers `{ redirect_url }` for
the browser to follow. Two rules guard it:

- **Only core's own UI** may link or unlink (403 `forbidden` for a token issued to any other client).
  A third-party client holding `core:account` could otherwise start a link itself, keep the cookie,
  and connect its own provider account to the user. Delegated `core:account` tokens can _list_ linked
  accounts (`GET /v1/account/identities`) but cannot link or unlink.
- **A recent login**: `auth_time` within 10 minutes, otherwise 403 `reauth_required` and the UI signs
  in again with `max_age=0`.

Linking checks no email: the user is signed in and chose the account. The callback returns to the UI
at `/account?linked=<slug>` on success or `/account?error=<code>` on failure (`identity_in_use` for a
provider account already linked to someone else, `already_linked` for a second link to the same
provider, among the codes below), and at `/login?error=session_expired` when the round trip is
already gone (a link session with no user lands on `/account?error=session_expired`).

`DELETE /v1/account/identities/{id}` unlinks, under the same two rules. It is refused with 409
`last_sign_in_method` when the user has no password and no other identity at an active provider (one
at a deactivated provider is no way in), and with 409 `sso_required` when their email's domain is
`ssoOnly` for that provider. An admin can unlink with
`DELETE /v1/admin/users/{id}/identities/{identityId}`, with the same 409s but no recent-login rule.

For an `ssoOnly` domain, the password check runs first and unchanged, so nothing reveals whether an
account exists: an unknown email and a wrong password both answer 401 `Invalid credentials`. A correct
password for a user who has linked the domain's provider is refused with 403 `sso_required` and
`provider: <slug>`, so the UI sends the user to its button; so is any correct password while that
provider is inactive. A correct password for a user with no link issues a single-use **link grant**
(valid `TOTP_VERIFICATION_TTL` seconds, bound to the browser by a cookie) and answers `redirect_url`
to the UI's `/login/link-required?grant=…&provider=<slug>&<authorize params>`.

That page's button opens `/oauth/upstream/<slug>/start?grant=…`, which needs the grant's cookie and
refuses (`session_expired`) a provider other than the one that owns the user's domain. On the
callback the linking rules apply (`identity_in_use`, `already_linked`), and the provider account must
be the user's own: its email verified (`email_unverified` otherwise; for Google, `hd` must name the
domain too) and equal to the user's email (`account_mismatch` otherwise), so a stolen password cannot
bind just any account at the provider. On success one transaction links the identity, clears the password
(audited as a `User` `UPDATE` with `passwordRemoved: true, reason: "sso_only"`), consumes the
grant and ends the user's other sessions, as a password reset does (`auth.user.sessions-revoked`),
and emits `auth.user.password-changed` with `reason: "sso_only"`; the login then finishes as a
provider login (`amr` `["fed"]`). A failure lands on `/login` with the authorize parameters and
leaves the grant usable until it expires.

When a second factor is due (by the usual rules: the user's TOTP, the instance policy, a role, or
`acr_values`, and the provider not `countsAsMfa`), a password and the provider account alone change
nothing: the callback records the vouched-for identity as a pending link (`auth.pending_identity_links`)
held by the TOTP step, and that transaction runs only when the TOTP or recovery code passes, in the
one that consumes the step (the login's `LOGIN` entry, written with the code, records the provider
and `amr` `["fed","otp"]`).
The pending link belongs to the grant: a password change, a sign-out everywhere or the grant's
expiry removes it and its TOTP step (400 `invalid_session`). A user who must first enrol goes to 2FA
setup with nothing changed, and after enrolling signs in again through the password and the
provider.

**No other provider.** An SSO-only domain's provider is the only way in for the domain's users.
A callback at any other provider that would sign one of them in, through an identity linked earlier
or by claiming an invite, ends on `/login?error=sso_required&provider=<slug>` naming the domain's
provider, and leaves the invite unclaimed. Linking another provider from the account page is refused
with 409 `sso_required` at `POST /v1/account/identities`, and at the callback
(`/account?error=sso_required`) when the domain turned SSO-only during the round trip. Identities
already linked at other providers stay (listed, and the user may unlink them), but sign no one in
while the domain is SSO-only; turning SSO-only off makes them usable again.

A user whose email at the provider differs from their email in core cannot complete the forced link
(`account_mismatch`), and an invite does not help, because claiming one also requires the
provider's verified email to equal the user's. The way through is to change the user's email in
core to the provider's (which withdraws their outstanding invites) and then issue an invite, or to
turn SSO-only off for the domain while the user links from the account page.

### What the sign-in is worth: `amr` and MFA

A provider login records its method in the session's `authMethods`, which become the tokens' `amr`:

| `amr`           | When                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `["fed"]`       | A provider login; the usual second-factor rules then apply (instance TOTP policy, roles with `requires_2fa`, `acr_values`), so the user may go on to the TOTP step |
| `["fed","mfa"]` | A login through a provider with `countsAsMfa` set: no TOTP step                                                                                                    |
| `["fed","otp"]` | A `["fed"]` login that then passed the TOTP step                                                                                                                   |

`usedMfa()` counts `mfa` alongside `otp` and `recovery`, so the ID token's `acr` reads
`urn:auth-service:mfa` for a `countsAsMfa` login and session reuse, `max_age` and `acr_values` need
no other rule.

**Re-authentication and `auth_time`.** A provider login's `auth_time` is the provider's own
(the ID token's `auth_time` claim), not the moment core's callback ran, so a silent sign-in on an old
session at the provider does not pass for a fresh login. When the authorize request carries
`prompt=login` or `max_age`, core sends them on to the provider (`max_age=0` also as `prompt=login`,
which it means), and checks the answer against them, counting from the start of the round trip with
30 seconds for clock skew: an `auth_time` older than `max_age` allows, or from before the round trip
under `prompt=login`, ends the callback on `/login?error=upstream_reauth_failed`. A provider that
sends no `auth_time` is taken to have just asked when `prompt=login` was sent, and is refused under a
`max_age` without it (OIDC requires the claim whenever `max_age` was asked). Without either, a
missing claim reads as now. This is what makes the account page's `max_age=0` re-sign-in, and an
app's `prompt=login`, ask the user again at the provider. After a TOTP step the login's `auth_time`
is that step's.

**`countsAsMfa` is a trust decision.** Turning it on says "this provider enforces its own MFA", and
core then treats the login as multi-factor **everywhere**: the instance policy, roles with
`requires_2fa`, and apps that ask for `acr_values=urn:auth-service:mfa`. Core cannot see what the
provider actually required. If the provider allows password-only sign-in, or an attacker can sign up
at it with a matching domain, a `countsAsMfa` provider hands them a login that skips every second
factor in core. Enable it only for a provider whose MFA you administer, and leave it off for public
providers. Since it bypasses even `admin`'s 2FA, only a caller holding `admin` through a global role
may turn it on (on create or `PATCH`; 403 otherwise) — `identity-providers.write` alone may turn it
off but not on. The trust is in who asserts the identity, so the same holds for a `PATCH` that
changes the `issuer` or `clientId` of a provider that keeps `countsAsMfa` on. A user who still must enrol or verify TOTP does so through the same steps as after a
password.

### Errors

The callback is a browser navigation, so its failures redirect to the admin UI's `/login` with the
authorize parameters (so the user can retry) and `error=<code>`. They never redirect to the client's
`redirect_uri`, because the user may still sign in another way.

| Code                                     | Meaning                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream_cancelled`                     | The provider returned `access_denied`: the user declined or cancelled                                                                                                                                                                        |
| `upstream_failed`                        | The provider returned an error, or the code exchange or ID token validation failed (logged with the cause), or sent a response over 1 MiB or a `sub` over 255 characters                                                                     |
| `upstream_reauth_failed`                 | The request asked for `prompt=login` or `max_age`, and the provider's `auth_time` is too old, or missing under `max_age` alone                                                                                                               |
| `session_expired`                        | No or mismatched `upstream_auth` cookie, or an unknown, used or expired round trip (10 minutes), or no authorize session cookie at start; for a link grant, a missing cookie, a used or expired grant, or another provider than the domain's |
| `provider_inactive`                      | The provider was deactivated before or during the flow                                                                                                                                                                                       |
| `no_account`                             | No linked identity, no invite, and no auto-accept domain of this provider (also: no email claim, or the domain's organization is archived or inactive)                                                                                       |
| `account_exists`                         | An auto-accept domain matched, but an account already has that email (or the invited user already has an identity at this provider)                                                                                                          |
| `email_unverified`                       | An invite or domain would match, or a forced link is completing, but the provider did not verify the email (or Google's `hd` did not match)                                                                                                  |
| `account_inactive`                       | The user is deactivated, or is a service account                                                                                                                                                                                             |
| `account_mismatch`                       | Forced link: the provider account's verified email is not the user's                                                                                                                                                                         |
| `identity_in_use`, `already_linked`      | Linking, on `/account?error=`, or an SSO-only user's forced link on `/login`: the provider account belongs to another user, or the user already has this provider (or this account)                                                          |
| `sso_required`                           | Password sign-in for an SSO-only domain whose provider the user linked (403 JSON, with `provider`); a callback at another provider (`&provider=`); 409 on unlinking the domain's provider or linking another                                 |
| `reauth_required`, `last_sign_in_method` | JSON from the account API: linking or unlinking without a login under 10 minutes old (403), or unlinking the only way in (409)                                                                                                               |
| `too_many_attempts`                      | Too many failed callbacks from this address (below); on `/account?error=` for a link                                                                                                                                                         |

A callback clears the `upstream_auth` cookie whatever its outcome. Callbacks whose round trip is
consumed count toward the same failure limiter as wrong passwords (5 per 300 seconds per IP; a
successful callback gives back its own attempt and clears no other); one over the limit is sent back with `too_many_attempts` instead of a JSON
429, since it is a browser navigation. A callback with no or a mismatched `upstream_auth` cookie
spends nothing: the callback carries no `client_id`, so the key is the address alone, and any web
page could otherwise send a visitor's browser to it a few times and lock out provider sign-in for
everyone behind that address.

## Transactional Outbox

Mutations open `db.$transaction(async (tx) => ...)` and pair the audit entry and webhook event with
the business write via `logAuditTx(tx, ...)` and `emitTx(tx, ...)` from `src/utils/outbox.ts` (see
the `outbox` skill).

## Archive / restore (Organizations, custom Roles), hard delete (custom Roles)

Organizations and custom roles carry `archivedAt` and `isActive`. `isActive` is the operational pause
toggle (PATCH-able; deactivating an org or role is what revokes tokens/sessions).

- `POST /v1/admin/{organizations|roles}/:id/archive` + `/restore` under `organizations.archive` /
  `roles.archive`. Archive 409s while `isActive=true` (deactivate first); restore returns the row
  still deactivated — nothing grants or authorizes again until an admin explicitly reactivates it.
- Archived rows: hidden from admin lists by default (`includeArchived=true` shows them), viewable by
  id (read-only), all other mutations 409 via per-id router guards.
- `DELETE /v1/admin/roles/:id` is a **hard delete** of a custom role: it cascades the role's
  assignment join rows (and its place among identity-provider domains' default roles) and revokes
  affected users' tokens first. Organizations have no delete —
  archiving is as far as they go. The default organization can never be archived.

## Permissions and system roles are declared in code

Permissions and system roles belong to a service — core or an app service — and arrive through its
declaration ([registry.md](registry.md)). Admins cannot create, edit, archive or delete them:

- `/v1/admin/permissions` is read-only (`GET`, with `includeRetired=true` to see retired ones).
- A system role (`serviceId` set, `isSystem: true`) accepts only a `requires2fa` change. Its
  permissions come from code; `POST /v1/admin/roles/:id/duplicate` copies them into a custom role.
- Changing any role's `requires2fa` needs a caller holding every permission the role grants (403
  otherwise, as when granting them): the policy guards what the role gives, so only `admin` changes
  it on core's `admin` role.
- A role held by an integration's account cannot come to grant `admin`, which integrations never
  hold: adding `admin` to it (`PUT …/permissions`) or reactivating it while it carries `admin` is
  `403 role_not_allowed_for_integration`, naming the integrations. The role's row lock serializes
  the check with an integration taking the role.
- Custom roles (`serviceId` null) are the admin's: any unretired permission can be added, and a
  retired one may stay on a role (`permissions[].retired`) but grants nothing.
- Resolution (`getUserPermissions`) skips archived, deactivated and retired roles, and retired
  permissions. Retired roles cannot be assigned.
- Archived and retired roles cannot be newly assigned, but `PUT /v1/admin/users/:id/roles` and
  `PUT /v1/admin/organizations/:id/members/:userId/roles` keep one the user already holds: the list
  `GET` returns can be sent back unchanged, and the assignment is still there if the role comes back.
- `PUT /v1/admin/users/:id/roles` refuses a service account: a service's roles are the access an admin
  approved for it under `/v1/admin/services`.

## Granting: only what you hold

A caller may grant only permissions their own token carries (`hasPermission`, so `admin` passes
everything and `x.write` covers `x.read`). Anything beyond is a 403 naming the permissions:

| Route                                                   | Checked                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `PUT /v1/admin/users/:id/roles`                         | The permissions of each role the user does not already hold globally               |
| `PUT /v1/admin/roles/:id/permissions`                   | Each permission the role does not already carry                                    |
| `POST /v1/admin/roles/:id/duplicate`                    | Every unretired permission of the source role                                      |
| `POST /v1/admin/services/:id/access/approve`            | The permissions of each requested role the service account does not already hold   |
| `PUT /v1/admin/organizations/:id/members/:userId/roles` | The permissions of each role the member does not already hold in that organization |

The first four grant globally, so they count only the caller's **global** permissions
(`globalGrantablePermissions` in `utils/grants.ts`: global roles, cut down to a delegated token's
ceiling) — not the org-scoped roles an organization token also carries, which reach only that
organization. The organization route counts what the caller holds there.

What a target already has is kept without the check, so a narrower admin can still edit a user or
role a broader one set up. `users.write` alone can no longer give anyone, itself included, `admin`.
Adding a member (`POST /v1/admin/organizations/:id/members`) assigns no role, so it has nothing to check.
Guest-assignable roles given through the guest endpoints are exempt ([Guest users](#guest-users)).

Taking power away is bounded the same way as a credential reset (below): deactivating a user
(`PATCH /v1/admin/users/:id` with `isActive: false`), removing any of their global roles
(`PUT /v1/admin/users/:id/roles`, or one at a time with `DELETE /v1/admin/roles/:id/users/:userId`),
ending one of their sessions (`DELETE /v1/admin/users/:id/sessions`)
and ending all of them (`DELETE /v1/admin/users/:id/sessions/all`) need the caller's global
permissions to cover every permission the user holds, in any scope (`assertMayDisempower`) — otherwise 403 naming those lacking. `users.write` alone cannot lock out or
strip an administrator, nor `users.delete` sign one out, nor `roles.delete` take an administrator's
`admin` role. Acting on yourself is not checked. Removing an org-scoped assignment
(`DELETE /v1/admin/roles/:id/users/:userId?organizationId=`) is bounded instead as setting a
member's org roles is: organization authority, and an org `admin` cannot remove an `owner`'s role.
Setting a member's org roles (`PUT /v1/admin/organizations/:id/members/:userId/roles`) also needs
the caller to hold, in that organization, every permission of each role it removes
(`assertCanTakeAway`) — otherwise 403 naming those lacking.

A service's or an integration's secret is a way into its account: `regenerate-secret` and
`revoke-previous-secret` under `/v1/admin/services/:id` and `/v1/admin/integrations/:id` need the
caller's global permissions to cover every permission the account holds, in any scope
(`assertMayTakeOverAccount`) — otherwise 403 naming those lacking.

Changing a role itself takes its permissions from every holder at once, so deleting a role
(`DELETE /v1/admin/roles/:id`), deactivating it (`PATCH` with `isActive: false`) and dropping
permissions from it (`PUT /v1/admin/roles/:id/permissions`) need the caller's global permissions to
cover every permission taken away (`assertCanTakeAway`) — otherwise 403 naming those lacking.
Each of the three revokes the access tokens of the service clients holding the role in its
transaction, and its audit entry counts them (`accessTokensRevoked`).

## Organizations: roles, members, activation

**Org-assignable permissions.** Each permission carries `orgAssignable` (default false), set by its
service's declaration ([registry.md](registry.md)). A role assigned within an organization grants
only its org-assignable permissions:

- `PUT /v1/admin/organizations/:id/members/:userId/roles` refuses, with 400 `not_org_assignable`, a newly
  assigned role carrying any other permission — whoever the caller is. System roles are refused
  outright (403), as before.
- The same route, and an identity-provider domain's `roleIds`, grant a role only if the caller
  holds its permissions **in the target organization** (`assertOrgAssignableRoles`): the caller's
  global roles and their roles there, cut down to a delegated token's ceiling. A token's own
  permissions count only when the token names that organization, so a role the caller has in
  another organization does not let them grant in this one.
- `PUT /v1/admin/roles/:id/permissions` refuses, with 409 `role_assigned_in_org` (naming up to ten
  of the organizations), adding a non-org-assignable permission to a custom role that has any
  org-scoped assignment. Duplicating a role is not affected: the copy has no assignments.
- `getUserPermissions` with an organization drops the non-org-assignable permissions of org-scoped
  assignments, whatever wrote them. This is the backstop for assignments made before the flag
  existed: the migration leaves them in place, inert, and core logs a warning with their count on
  every start until an admin replaces them.

Core marks as org-assignable the permissions whose every use is confined to the token's
organization: `file-service.{buckets,objects,permissions,shares}.*`, `webhooks.{read,write,archive,delete,emit}`,
`webhooks.event-types.read`, and `audit-logs.{read,write}`. Everything that reaches past one
organization is global-only: `admin`; `users.*`, `roles.*`, `permissions.read`, `clients.*`,
`settings.*` and `services.*`; `organizations.*`, whose holders pass `requireOrgRole` for any
organization; and `file-service.admin`, `webhooks.admin` and `audit-logs.admin`, which act on any
organization. `audit-logs.delete` has no route yet and stays global-only until one shows its scope.
The list lives in `src/definitions/permissions.ts`.

**Activation.** Changing an organization's `isActive` (`PATCH /v1/admin/organizations/:id`) needs
`organizations.write`; an owner can no longer deactivate or reactivate it. An inactive organization
is frozen for its members: `requireOrgRole` refuses every tier above `member` with 403 unless the
caller has the platform permission, so owners and org admins cannot rename it, remove members,
change member tiers, or assign roles. Members can still read it.

**Members.** `POST /v1/admin/organizations/:id/members` needs the platform permission
`organizations.write`; an organization's owners and admins cannot add anyone (403), though they
still change members' tiers and roles and remove them. It adds only an active person: core's system
user, a service account or an inactive user is refused with 400 `user_not_addable`, as is a guest
who already belongs to an organization; a guest joins only as `member` (400 `guest_tier`). An org admin
does not manage an owner: changing an owner's tier (`PATCH …/members/:userId`) or roles
(`PUT …/members/:userId/roles`) needs an owner or `organizations.write` (403 otherwise).

**Scope of roles.** `GET /v1/account/me` and `/oauth/userinfo` list the same roles that give their
permissions: global ones plus the token's organization's, unexpired, of an active, unarchived,
unretired role. For a guest, inert roles are left out ([Guest users](#guest-users)).

## Guest users

A guest is a temporary login: a row in `auth.users` with `userType = guest` and an `expiresAt`, for a
customer who should reach only what they were shared. It is the same row for life: extending,
re-sharing and promoting keep one id, so roles, grants and audit history carry over.

**Usable.** A guest is usable while `isActive` and `expiresAt > now`. Expiry is checked live on every
sign-in and token path (`isUsableAccount`, `utils/users.ts`: the password step, access-token checks
behind `requireAuth`, `/oauth/introspect` and the socket, the refresh grant and the session check),
so no job gates access and an extension needs no reactivation. Expiry never sets `isActive = false`:
"expired" and "deactivated" stay distinguishable (`status` is `active`, `expired` or `deactivated`),
but an expired guest gets the deactivated responses, so a login is not an expiry oracle. Access and
refresh token lifetimes are capped at the remaining time, and extending a guest lifts their live
refresh families.

**One organization, member tier.** A guest is a `member` of at most one organization with only
org-scoped role assignments. A membership of an **archived** organization does not count
(`guestOrganizationId`, `utils/guests.ts`): that guest belongs to none, is managed only with
`organizations.write`, and may be invited into or added to another organization. The archived
membership grants nothing (no token is issued for an inactive or archived organization, and the
`memberships` scope skips it). Restoring the organization removes it from such a guest who has
joined another meanwhile, with their roles and bucket grants there, audited and emitted as
`auth.organization.member-removed`.

| Refused                                                                                                       | Code                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Adding a guest who already belongs to an organization to another (`POST /v1/admin/organizations/:id/members`) | 400 `user_not_addable`          |
| Making a guest an owner or admin                                                                              | 400 `guest_tier`                |
| Assigning a guest a global role                                                                               | 400 `guest_global_role`         |
| Assigning a guest a role that is not guest-assignable                                                         | 400 `role_not_guest_assignable` |
| An identity invite for a guest                                                                                | 400 `user_not_invitable`        |

**Password only.** A guest cannot sign in through an identity provider, is not matched by domain
auto-accept (`account_exists`, as for any user) and cannot link a provider from the account page. All of
this lifts on promotion.

**SSO-only domains.** A setup link is never redeemable for an address on an SSO-only domain, so one is
not issued: an invite with `initialAccess.type: "password_setup_link"` (for a new guest, or an existing
one who has no password) and `POST /v1/admin/guests/:id/password-setup-link` answer `409
sso_only_domain`, before anything is written. Give such a guest a password with
`initialAccess.password` instead.

### The permission floor

Applied in `permissionsInScope` (`utils/db/roles.ts`), the one place permissions are resolved, so it
holds for tokens, introspection, `check-permission`, `my-permissions` and 2FA scope alike:

1. For a guest only **org-scoped assignments of currently guest-assignable roles** count. Un-flagging
   a role makes guests' assignments inert at once (kept, granting nothing); flagging it again
   restores them.
2. Of core's permissions a guest holds only `GUEST_CORE_PERMISSIONS`
   (`definitions/guests.ts`): `file-service.objects.read` and `file-service.objects.write`. A core
   permission added later is closed to guests by default. Service permissions are not filtered here.

Inert roles are hidden: the userinfo `roles` claim and `GET /v1/account/me` list only what counts.
Credential-reset style guards (`assertMayTakeOverAccount` and the like) still count a guest's
dormant permissions, so the guard cannot be sidestepped by un-flagging. Bucket grants are unchanged:
a guest with `file-service.objects.read` sees only buckets that grant them `canRead`, and holds no
`file-service.shares.*`, so cannot create shares.

### Guest-assignable roles

Core declares no guest role. Which roles guests may hold is a choice, from three sources:

| Source         | How                                                                                                                               | Admin-editable                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Provisioning   | `guestAssignable: true` on a custom role in a document's `roles` ([provisioning.md](provisioning.md))                             | No (`409 managed_by_provisioning`) |
| Admin API / UI | `PATCH /v1/admin/roles/:id { guestAssignable }` (`roles.write`) on an admin-made custom role; `POST /v1/admin/roles` takes it too | Yes                                |
| Defaults       | `guests.defaultRoles` in one provisioning document                                                                                | Through the document               |

Only **custom** roles (`serviceId` null) can be guest-assignable; a system role never is (a CHECK
keeps the flag false). A guest-assignable role must be org-assignable and carry no core permission
besides `file-service.objects.read` and `file-service.objects.write`. `PATCH`, and adding a permission
to a flagged role, refuse otherwise with 400 `role_not_guest_assignable`, naming the permissions at
fault. Changing the flag, through the API or a document, emits `auth.role.guest-assignable-changed`.

The default roles are stored in the system setting `guestDefaultRoles` (role ids), written only by
provisioning. An invite that names no roles gets them; an id whose role has since been un-flagged or
retired is skipped at invite time. With none, the guest can sign in and manage their own account
and nothing more.

### Inviting, extending, promoting

Permissions `users.guests.read` and `users.guests.write` are global-only. The core role
`guest_inviter` (requestable by a service in its provisioning document) holds both.

**Organization scope.** The guest endpoints (`/v1/admin/guests`, reads and writes) reach only an
organization the caller acts in: one they are a member of, or, for a service account, the one its
client belongs to. A holder of `organizations.write` acts in every organization. The list shows
only the guests in those organizations. An invite naming another organization is
`403 organization_not_permitted`. On `/v1/admin/guests/:id` the scope is checked before the user is
looked at (`getManagedGuest`): without `organizations.write`, a guest elsewhere or in no
organization, a user who is not a guest and an unknown id all answer `404 not_a_guest`, so an
outsider learns nothing about the user. Promotion is not scoped: it is a `users.write` action, and
`users.write` is global.

**Granting.** "Granting: only what you hold" does not apply to guest-assignable roles given through
the guest endpoints: flagging the role was the grant decision and `users.guests.write` the right to
apply it (a service account does not hold its own service's permissions). The ordinary role
endpoints follow the normal rule.

| Route                                                       | Permission                                                          | Does                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/admin/guests`                                     | `users.guests.write`                                                | Invite (below)                                                                                                                                         |
| `GET /v1/admin/guests`                                      | `users.guests.read`                                                 | List guests (also `GET /v1/admin/users?filter[userType]=guest`, `users.read`)                                                                          |
| `GET /v1/admin/guests/options`                              | `users.guests.write`                                                | The invite form's data without `roles.read`: `{ roles, defaultRoleIds, maxTtlSeconds }`, the roles a guest may be given now                            |
| `GET /v1/admin/guests/:id`                                  | `users.guests.read`                                                 | One guest (the user plus `organizationId`, unwrapped); `404 not_a_guest` for a non-guest or one out of scope                                           |
| `PATCH /v1/admin/guests/:id { expiresAt, name? }`           | `users.guests.write`                                                | Extend or shorten (`expiresAt` is a required RFC 3339 date-time, `null` is a 400; a time in the past ends access now); returns the guest. As `GET` for 404 |
| `POST /v1/admin/guests/:id/password-setup-link { notify? }` | `users.guests.write`; for a guest who has a password, also `users.write` and the "holds every permission" rule | Issue a fresh link; earlier ones die. `200 { url, expiresAt }`; `403 guest_has_password` when the guest has a password and the caller lacks `users.write`; `409 guest_not_usable` for a deactivated or expired guest, `409 sso_only_domain` for an email on an SSO-only domain, `409 email_not_configured` |
| `POST /v1/admin/users/:id/promote`                          | `users.write` plus the "holds every permission the user holds" rule | `userType = human`, `expiresAt = null`; id, membership, roles, password, grants and history kept; live setup links and forced-change grants retired. Returns the user. `409 password_not_user_set` while the password is one someone else chose. An expired guest can sign in again |

The admin UI's Auth Admin → Guests page lists guests through `GET /v1/admin/guests`, so
`users.guests.read` alone reaches it, with extend and password-link actions; its invite form reads
`GET /v1/admin/guests/options` and offers only expiries within `maxTtlSeconds`.

Every user the admin API and webhooks return carries `expiresAt` (null unless a guest),
`status` (`active`, `expired`, `deactivated`) and `passwordChangeRequired`. `GET /v1/admin/guests`
is the usual page envelope of users, filterable by `organizationId`, `email`, `isActive`,
`expiresAt` and `createdAt` and sortable by `id`, `email`, `createdAt` and `expiresAt`; the users
list takes `filter[userType]=guest`. Deactivating, ending sessions and resetting a password use the
ordinary user endpoints. After promotion the guest restrictions lift: SSO, linking and global roles
are allowed. The 2FA rules for regular users apply too: when the policy is `required` or a role the
user holds requires 2FA, access tokens from a sign-in without a second factor are revoked, so the next
refresh meets the step-up.

**Who chose the password.** `users.password_set_by_user` is false while the password is one someone
else chose: an invite's `initialAccess.password`, or one an admin set (`POST /v1/admin/users`,
`PATCH /v1/admin/users/:id`). It turns true when the user sets one through a setup link, the forced
change or `POST /v1/account/password`. Promotion is refused while it is false (`409
password_not_user_set`), since whoever chose the password could sign in as the promoted account:
send the guest a setup link (which, for a guest with a password, takes the credential-reset
authority above) and promote once they have used it.

**Promotion keeps the account as it is.** Promotion hands over the account with its password, TOTP
and sessions; it does not reset them. While the account is a guest, whoever invited it can sign in
as it (with a password they chose, or a link they were given) and set a password of their own,
which then counts as user-set. That is within what inviting allows: the inviter could create a guest
with the same roles anyway. A promoted account gains more (no expiry, roles no longer limited to
guest-assignable ones, whatever is granted next), so a promoter who wants only the person to hold
it resets their credentials (`PATCH /v1/admin/users/:id`, then a setup link or the person's own
sign-in) before granting more.

**Setup links and grants do not survive the account changing hands.** A live setup link and any
pending forced-change grant are retired on promotion, on an admin password reset, email change or
deactivation (`PATCH /v1/admin/users/:id`), and when the user changes their own password: the
inviter got the link's URL back and must not keep a way in.

**`POST /v1/admin/guests`** takes `email`, optional `name`, `organizationId` (default: the token's
organization, else the default organization, which must be active: 400 `organization_inactive`),
`roles` (names or ids; 400 `unknown_role`), exactly one of `expiresAt` and `expiresIn` (seconds;
in the future, no further than `GUEST_MAX_TTL_SECONDS` from now), and `initialAccess`
(required): either `{ "type": "password_setup_link", "notify": true }` or
`{ "type": "password", "password": "…", "mustChange": true }` (`mustChange` defaults to `true`).
The email is normalized, and a per-email advisory lock serializes concurrent invites. What happens
depends on who holds the email:

| Existing account                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                                                        | Creates the guest, membership and roles (the default roles when `roles` is omitted), sets up initial access: `201 { user, created: true, passwordSetupUrl? }` (`user` carries `organizationId`)                                                                                                                                                                                                                                                                                                            |
| a guest in the same organization or in none, expired or not | Extends (a guest in no organization first joins this one as a `member`, which needs `organizations.write`: otherwise `409 guest_unassigned`): `expiresAt` becomes the later value, and refresh tokens capped at the old expiry are lifted (each to its family's start plus `JWT_REFRESH_TOKEN_TTL`, capped at the new expiry). Roles named are added, none removed; omitted `roles` adds nothing (defaults apply only on create). Name and password are untouched; `initialAccess` applies only if they never set a password: `200 { user, created: false, passwordSetupUrl? }` |
| a guest in another organization                             | `409 guest_in_other_organization`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| a human                                                     | `409 user_exists` with `userId`; the app grants that user directly                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| a service account, the system user or a deactivated user    | `409 user_not_invitable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The refusals above say whether the email has an account, so only a caller holding `users.read`
(which lists every user anyway) gets them. Any other caller gets one `409 email_unavailable` for all
of them, without `userId`.

`notify: true` emails the link and needs a default email connection (`409 email_not_configured`);
`passwordSetupUrl` is returned either way, so an app can deliver it itself. A user has one live
password link, so an anonymous reset request for that address (`POST /v1/password-reset`) replaces a
live setup link with a reset link sent to the guest. Each operation runs in
one transaction with its audit entries and events. The guest events carry the user plus
`organizationId`: `auth.guest.invited` (`roleIds`), `auth.guest.extended` (`previousExpiresAt`,
`rolesAdded`, and `change`: `extended`, `shortened` or `ended`; also emitted by `PATCH`, with no
roles added) and `auth.guest.promoted`. They are emitted under the **guest's organization** (null
for a guest in none), not the default one: `users.guests.read` is scoped to the organizations one
acts in, so only that organization's endpoints, and service endpoints of all organizations, receive
them.

The invite also records what it creates as the ordinary endpoints do, in the same transaction: a new
guest's `CREATE User` entry (`metadata.action: guest_invited`, with `email`, `name`, `userType`) and
`auth.user.created`; a membership added (on create, or when a guest in no organization joins) as
`CREATE OrganizationMember` and `auth.organization.member-added`; roles added as
`roles_changed` and `auth.organization.member-roles-changed` (`roleIds` being the full set held).
These platform events keep the default organization, as their own endpoints emit them.

`PATCH` audits a later expiry as `guest_extended`, an earlier one still in the future as
`guest_shortened`, and one not in the future as `guest_access_ended`. Ending access also revokes the
guest's live access tokens and closes their sockets; their refresh tokens are lowered to the new
expiry, so they are spent too.

### Password links

Core issues three kinds of one-time link through `utils/userLinks.ts`, all stored in `auth.user_link_tokens` (purpose `setup`, `reset` or `verify`): a password **setup** link, a password **reset** link ([Password reset](#password-reset)) and an **email verification** link ([Email verification](#email-verification)). A user has at most one live password link (setup or reset; issuing either replaces it) and at most one live verify link.

#### Setup link

Issued by `issuePasswordLink` as
`${UI_BASE_URL}/set-password#token=<token>`: 32 random bytes, base64url, valid for
`PASSWORD_SETUP_TTL_SECONDS` (72 hours by default), single use, and only its SHA-256 is stored in
`auth.user_link_tokens`. The token is
in the URL **fragment**, so it never reaches server logs, `Referer` headers or link previews. The
helper does not refuse unusable users itself; the invite endpoint checks.

The email is a **sensitive** notification: its content is redacted from the admin APIs (`content:
null`, `contentRedacted: true`), nulled once the notification is terminal, and an admin retry of one
answers `409 content_redacted` ([notifications.md](notifications.md)).

Both routes are public, rate limited per IP, and serve reset links as well. They give one uniform
`404`, which counts against the caller's IP, for an unknown, used or expired token and for a user the
link no longer reaches: for a setup link, one no longer a guest; for either kind, one whose email
domain is now SSO-only, where the provider holds the credential.

- `POST /v1/password-setup/inspect { token }` returns `{ email, name, expiresAt, purpose }` (the
  link's expiry; `purpose` is `setup` or `reset`) and uses nothing up.
- `POST /v1/password-setup { token, password }` sets the password under the password rules, consumes
  the token with a conditional update (of two concurrent requests one wins), clears
  `passwordChangeRequired` and ends the user's other sessions, in one transaction; `204`. Emits
  `auth.user.password-set` with `via` `setup` or `reset` (never the password), and deletes the
  user's pending forced-password-change grants. A **reset** link marks the address verified: only
  the inbox received it. A **setup** link does not, because its URL is returned to the inviter
  (`passwordSetupUrl`, with `notify` too), so redeeming it proves nothing about the address.
  The UI then shows a "Password set" screen. Its Sign in button goes to `/` after a setup link; after
  a reset it returns to the sign-in page the reset was started from (see
  [Password reset](#password-reset)).

Issuing emits `auth.user.password-setup-link-issued`. The hourly auth cleanup deletes a token
`AUTH_TOKEN_GRACE_MS` (7 days) after it expired or was used (retired included).

#### Rolling deploys and rollback

The migration `20261108120000_user_links` renames `auth.password_setup_tokens` to
`auth.user_link_tokens`. During a rolling deploy, pods still on the older image fail on their
setup-link routes (`/v1/password-setup`, the guest invite's link) and in the hourly auth cleanup
until they are replaced. Rolling the image back past the migration needs the schema reversed first,
which drops reset and verify links and every verification timestamp:

```sql
DELETE FROM "auth"."user_link_tokens" WHERE "purpose" <> 'setup';
DROP INDEX "auth"."user_link_tokens_user_id_live_password_key";
DROP INDEX "auth"."user_link_tokens_user_id_live_verify_key";
ALTER TABLE "auth"."user_link_tokens" DROP CONSTRAINT "user_link_tokens_email_purpose_check";
ALTER TABLE "auth"."user_link_tokens" DROP COLUMN "email", DROP COLUMN "purpose";
ALTER INDEX "auth"."user_link_tokens_expires_at_idx" RENAME TO "password_setup_tokens_expires_at_idx";
ALTER INDEX "auth"."user_link_tokens_token_hash_key" RENAME TO "password_setup_tokens_token_hash_key";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "user_link_tokens_created_by_fkey" TO "password_setup_tokens_created_by_fkey";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "user_link_tokens_user_id_fkey" TO "password_setup_tokens_user_id_fkey";
ALTER TABLE "auth"."user_link_tokens" RENAME CONSTRAINT "user_link_tokens_pkey" TO "password_setup_tokens_pkey";
ALTER TABLE "auth"."user_link_tokens" RENAME TO "password_setup_tokens";
CREATE UNIQUE INDEX "password_setup_tokens_user_id_live_key" ON "auth"."password_setup_tokens" ("user_id") WHERE "used_at" IS NULL;
ALTER TABLE "auth"."users" DROP COLUMN "email_verified_at";
DROP TYPE "auth"."user_link_purpose";
DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '20261108120000_user_links';
```

### Password reset

`POST /v1/password-reset { email, client_id? }` (public) emails a reset link. It **always answers
`202` with an empty body, and answers before doing any work**: the reset is processed after the
response, so no account information leaks through the status, the timing or an error. A link is sent
only when the address has an account that is active and unexpired, is a human or guest (not a
service account or the system user), is not on an SSO-only domain, and a default email connection
exists (the sign-in page asks `GET /v1/password-reset/status`, `{ enabled }`, before offering
"Forgot password"). A user who has no password yet (signs in through a provider) qualifies.

The link is `${UI_BASE_URL}/set-password[?client_id=…]#token=<token>`, valid for
`PASSWORD_RESET_TTL_SECONDS` (1 hour by default, 5 minutes to 24 hours), single use, and replaces
any earlier setup or reset link. `client_id` is carried only if a client with that ID exists, so the
page shows that client's branding. The return to the app comes from the browser instead: the sign-in
page remembers its authorize request in `localStorage` for an hour (the reset link's default
lifetime), so the link opened in another tab of the same browser still offers Sign in back to it,
while the admin UI's own sign-in completes only in the tab that started it, which holds its PKCE
verifier. The email ("Reset your password") is a sensitive notification. Redeeming
it is `POST /v1/password-setup` ([Setup link](#setup-link)): it sets the password, marks the address
verified, ends the other sessions, clears pending forced-password-change grants and clears the
account's login backoff (the failed sign-ins that usually come before a reset). A link whose
user has since moved to an SSO-only domain answers the uniform `404`.

**Limits.** Reset requests are limited per hour, each limit counted on every request whether or not
the address has an account, and a request over any of them is still `202` but sends nothing (logged
at info):

| Limit                    | Per hour | Key                                   |
| ------------------------ | -------- | ------------------------------------- |
| Per IP                   | 10       | the client IP, for any addresses      |
| Per address and IP       | 3        | the normalised address and client IP  |
| Per address, all sources | 10       | the normalised address                |

They are spent in that order, and a request refused by one spends none after it, so one source
spends at most 3 of an address's 10. Using up a victim's allowance, and so delaying their genuine
reset for up to an hour, takes requests from at least four IPs; it is the cost of leaking nothing
about which addresses exist. Each request that gets through still issues a new link and retires the
one before it. Without Redis the route answers `503`, whatever the address. (The route also has the
usual per-IP request limits.) A reset issued is audited
(`password_reset_requested`, with the requesting IP) and emits `auth.user.password-reset-requested`.

### Email verification

`users.email_verified_at` records when an address was proven; `email_verified` in the userinfo
response, the ID token **and `/oauth/introspect`** (they share one claims builder) is
`emailVerifiedAt !== null`, and the account and admin user objects carry `emailVerified` and
`emailVerifiedAt`. Accounts that existed before the feature were marked verified by the migration.
A changed address is unverified until proven again.

An address becomes verified when:

- the user opens a verify link (`POST /v1/email-verification { token }`, public; `inspect` returns
  `{ email, expiresAt }` and consumes nothing), which ends no session;
- the user redeems a reset link, which went only to that address (a setup link does not verify: its
  URL is returned to the inviter);
- the first admin completes setup (`POST /v1/setup`, `via: setup`);
- a **non-forced** provider sign-in links to the account, an invite is claimed, autoAccept applies or
  the user links an account from the account page, when the provider vouches for the same address
  (`email_verified` from the provider). A sign-in or invite claim of a deactivated or expired
  account verifies nothing.

A **forced** provider link (an SSO-only domain's first sign-in) does **not** mark the address
verified.

Verify links are `${UI_BASE_URL}/verify-email#token=<token>`, valid for
`EMAIL_VERIFICATION_TTL_SECONDS` (3 days by default, 1 hour to 14 days) and bound to the address
they were issued for: a later change of email voids them. The email ("Confirm your email address")
is sensitive. They are sent by:

- `POST /v1/account/email-verification` (own address; 1 per minute and 5 per hour per user, `429`);
- `POST /v1/admin/users/:id/email-verification` (`users.write`; the link is never returned, so an
  admin cannot confirm for the user; 5 per hour per target user, whoever sends them, `429`, since
  each send retires the link sent before);
- an admin changing a user's email (`PATCH /v1/admin/users/:id`), which also marks the new address
  unverified. No link is sent when the user is inactive, expired or deactivated in the same
  request, or no email connection exists; the update succeeds either way.

Both resends refuse with `409 already_verified`, `409 user_not_verifiable` (service accounts, the
system user, deactivated users and expired guests) and `409 email_not_configured`. Events: `auth.user.email-verification-sent`
and `auth.user.email-verified` (`via`: `link`, `password_link`, `provider` or `setup`), each audited.
Verification is recorded only; core does not yet require it for sign-in.

The admin UI opens `/set-password`, `/forgot-password` and `/verify-email` signed out.

### Forced password change

With `passwordChangeRequired` set (a guest created with `initialAccess.password`), a **password**
login does not issue a code: it redirects to `/login/change-password` with a one-time grant, and
`POST /oauth/password-change { change_grant, password }` sets the new password (it must differ:
`password_unchanged`), clears the flag and ends other sessions; the login then restarts. The grant
is bound to the browser by a cookie holding a separate random secret (only its hash is stored on
the grant; the URL never carries it), so a grant lifted from a URL is refused elsewhere
(`invalid_change_grant`; an expired one is `change_expired`). The step comes **after** the TOTP
step: a user with TOTP enabled enters a code (or a recovery code) first, and the TOTP handlers issue
the grant, so the password alone cannot replace the password. The restarted login asks for a code
again. A provider login skips the step and leaves the flag set, which matters for a promoted
ex-guest.

### Two-factor for guests

The instance `totpPolicy: required` does not force a guest to enrol (`disabled` still wins). A
guest-assignable role with `requires2fa` does, since an admin chose it. Flagging such a role, or
assigning it, revokes the password-only tokens of the guests it reaches, as for any holder.

## Two-factor authentication (TOTP)

The `totpPolicy` system setting (`PATCH /v1/admin/settings`) is `disabled`, `optional` (the default) or
`required`:

- `required` — every user must enrol; login redirects to setup until they do. Guests are not forced
  by it ([Guest users](#guest-users)).
- `optional` — users may enrol; a user holding an active role with `requires2fa` must.

`settings.write` may tighten the policy, but relaxing it (`required` to anything, `optional` to
`disabled`) needs `admin` through a global role (403 otherwise), checked in the change's
transaction under a lock on the setting: `disabled` overrides every role's `requires2fa`, `admin`'s
included, so no narrower permission bounds it.

Enrolling at login (`/oauth/totp/setup/verify`) ends the user's other sessions in the transaction
that enables TOTP, as enrolling from the account page does: sessions opened with the password alone
do not outlive the switch to 2FA.

Which roles count is the same filter as for permissions — unexpired, of an active, unarchived,
unretired role — in the scope of every organization the user could sign in to: global assignments,
plus those of each active organization the user is a member of. 2FA is decided at the password step,
before an organization is chosen, so a role requiring it in any organization the user may pick
applies. `GET /v1/account/me`, `GET /v1/account/totp`, the admin's `GET /v1/admin/users/:id/totp`, and the
refusal to disable TOTP on `DELETE /v1/account/totp` use the same scope, so a user cannot turn off what
the next sign-in would demand. An assignment in an organization the user has left, or one that is
inactive, does not count.

2FA required of a user after a login without it — a role they hold gains `requires2fa`, they are
given such a role, or the policy becomes `required` — is enforced on what that login left too
(`stepUpRequired` in `utils/authorization.ts`, by the same rule as the password step): `prompt=none`
over its SSO session answers `error=interaction_required`, an `org_id` switch falls through to the
password login (which asks for the code, or for enrolment), no code is issued to a continuation of it,
and its refresh tokens are refused with `invalid_grant`, so the client signs the user in again. A
login that used a second factor (`otp`, `recovery`, or a provider's `mfa`) is unaffected, as are
client-credentials tokens. Enrolling from the account page does not count: the session that enrolled
keeps going.

Permissions are read on every request, so a password-only access token would otherwise keep working
under the new requirement until it expired. The change that makes it — `PATCH /v1/admin/settings`
moving the policy up (to `required`: every person; `disabled` to `optional`: holders of a role with
`requires2fa`), `PATCH /v1/admin/roles/:id` turning `requires2fa` on or reactivating such a role (its
holders), and `PUT /v1/admin/users/:id/roles` or `PUT /v1/admin/organizations/:id/members/:userId/roles`
adding such a role (that user) — revokes those people's live access tokens from a login without a
second factor (`db.accessTokens.revokeWithoutMfa`) in its transaction, and closes their sockets. The
client's next refresh then meets the step-up above. The audit entry records `accessTokensRevoked`.
Other ways a role comes to count (joining or reactivating an organization) revoke nothing; refresh
and the next login still enforce them.

- `disabled` — new enrolment is refused with 403 `totp_disabled` on `POST /v1/account/totp/setup`,
  `/v1/account/totp/setup/verify`, `/oauth/totp/setup` and `/oauth/totp/setup/verify` (a setup started
  before the change cannot be completed), and `requires2fa` is ignored. Users already enrolled keep
  TOTP, still verify at login, and can disable it.

Enrolling during login is bound to the password check. When `POST /oauth/authorize` accepts the
password of a user who must enrol, it stores a setup grant in `auth.totp_setup_grants` — a random
256-bit token kept only as its SHA-256, bound to the user and the OAuth request (client, redirect
URI, scopes, state, PKCE challenge, nonce, `max_age`, `acr_values`, `prompt`), valid for
`TOTP_VERIFICATION_TTL` — and redirects to `/login/2fa/setup?setup_grant=…`, setting the same value
in the `tereo_2fa_setup_grant_{client_id}` cookie. `POST /oauth/totp/setup` takes only
`setup_grant`; it must match the cookie, it is consumed on use, and the user and OAuth request come
from it. The setup session it starts is then completed with `POST /oauth/totp/setup/verify`, after
which the UI restarts `/oauth/authorize` and the user logs in with the new factor. Signed-in users
enrol from `POST /v1/account/totp/setup`, which acts on the token's user. Each verify completes only
its own kind of setup: `/oauth/totp/setup/verify` refuses a setup begun from the account page, and
`/v1/account/totp/setup/verify` one begun at login, with 400 `invalid_setup_token`.

A TOTP code is accepted once. `auth.users.totp_last_window` holds the 30-second step of the last
code accepted for the user's secret; every check — the 2FA step at login, both setup verifies, and
`DELETE /v1/account/totp` and `POST /v1/account/totp/recovery-codes` — refuses a code from that step or
an earlier one with `invalid_code` (401 at login, 400 on the `/v1/account/totp` routes, whose
bearer token is valid), and records the new step with a conditional update, so two
concurrent submissions of one code cannot both pass. Disabling TOTP clears it. Recovery codes are
single-use on their own and do not touch it.

The login flow's 2FA, org-select and consent sessions (`auth.totp_verifications`,
`auth.org_selection_sessions`, `auth.consent_sessions`) are found by the SHA-256 of their token, as
the setup grant is; the URL and the cookie carry the token itself.

Starting a setup is audited (`User`, action `UPDATE`, `metadata.action` `totp_setup_started`, with
`clientId` when begun at login). Enabling and disabling are audited (`totp_enabled` /
`totp_disabled`) and emit `auth.user.totp-enabled` / `auth.user.totp-disabled`, whether the user
disables it (`DELETE /v1/account/totp`, confirmed with a current TOTP code — not a recovery code).
Users regenerate their own recovery codes (`POST /v1/account/totp/recovery-codes`, audited as
`totp_recovery_codes_regenerated`). Like setup, regenerating codes and disabling TOTP are for core's
own UI only (403 `forbidden` otherwise) and need a login under 10 minutes old (403 `reauth_required`,
and the UI signs in again with `max_age=0`): a stolen session or a third-party `core:account` token
must not strip the second factor or take the codes. Enabling and disabling end the user's other
sessions in the transaction that makes the change, recorded as `sessions_revoked`. No admin route
returns a user's codes. An admin with
`users.write` resets a user's TOTP instead (`POST /v1/admin/users/:id/totp/reset`, the only admin
2FA route): TOTP is disabled and the recovery codes deleted, so the user enrols again — audited as
`totp_reset`, with an `auth.user.totp-reset` event.

An admin password reset (`PATCH /v1/admin/users/:id` with `password`) and a TOTP reset both end all of
the user's sessions and token families, in the transaction that makes the reset
(`endUserSessions`, recorded as a `sessions_revoked` entry and an `auth.user.sessions-revoked`
event); an admin resetting their own password keeps the session they act from. Deactivating a user
(all their sessions) and removing a member (their sessions in that organization) are recorded the
same way, in the transaction that ends them. Every such sign-out
also revokes the access tokens issued without a refresh token (clients without the `refresh_token`
grant), all but the caller's own, and closes their sockets. An app service using `@tereo-io/sdk`
may cache an active introspection for up to its `introspectionCacheTtlSeconds` (60 s by default,
at most 300 s), so it can keep accepting a signed-out or revoked token that long. Either reset, an
email change, an identity invite or an admin identity unlink
(`DELETE /v1/admin/users/:id/identities/:identityId`) hands the caller the account or changes how it
is entered, so it may not reach beyond what the caller holds (`assertMayResetCredentials`): every permission the user holds — through global roles
and through roles in any organization, active or not (an org-scoped role grants only its
org-assignable permissions), counting deactivated roles too, since an admin can reactivate one
(archived and retired ones do not count) — must be covered, hierarchically, by the caller's global permissions,
cut down to their token's scope ceiling for a delegated token. The caller's org-scoped roles do not
count, since the account reaches beyond that organization. Otherwise 403, naming the permissions the
caller lacks: `users.write` alone resets only users who hold no more than `users.write`, and no
third-party client's token (no core API scope reaches `admin`) resets an administrator. An `owner`
or `admin` membership in any organization (inactive and archived ones included) is authority no
permission names, so it needs the caller to hold `organizations.write`, the global permission that
manages any organization's owners and admins (`requireOrgRole`): otherwise 403 naming
`organizations.write`. The same rule covers deactivating, ending sessions of and removing roles from
another user (`assertMayDisempower`), and reactivating a deactivated user (`assertMayReactivate`),
whose account comes back with all it holds. The system user and a service's account are refused, as
on the other admin user routes.

This check and `assertMayDisempower` run inside the change's transaction, under a per-user advisory lock
(`db.users.lockAuthority`) that every admin change to the user's roles — global or in an organization,
membership additions, tier changes and removals included — takes too, first: a role granted to the user concurrently is either
committed before the check sees it, or waits until the reset or removal has committed. Editing a
role's permissions or restoring a role does not take it, so a role the user already holds can still
gain permissions while the check runs.

## Session lifetimes

Every lifetime is absolute — using a session never extends it. The SSO session also has an idle
limit, `USER_SESSION_IDLE_TTL` (3 days by default, at most `USER_SESSION_TTL`): its `last_used_at` is
set whenever it issues a code, and one idle longer counts as expired wherever it would be continued
without a password (`prompt=none`, an `org_id` switch, the code issue that ends either). A refresh
does not count as use: an app refreshing its tokens keeps its own family alive, not the browser's
SSO session. An idle session's row stays until its absolute expiry, so a logout still finds it and
revokes the token families issued under it, and the browser's next password login takes the row over
(`includeIdle` on the lookups in `utils/db/userSessions.ts`).

| Setting                  | Default        | What it bounds                                                                                                                                     |
| ------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_TOKEN_TTL`   | 3600 (1 h)     | Access and ID tokens                                                                                                                               |
| `JWT_REFRESH_TOKEN_TTL`  | 2592000 (30 d) | A refresh-token family, from the code exchange. A rotated token keeps the family's original expiry                                                 |
| `USER_SESSION_TTL`       | 604800 (7 d)   | The SSO session behind `prompt=none` and org switching (`org_id`). A session continued without a password keeps the expiry of the one it came from |
| `USER_SESSION_IDLE_TTL`  | 259200 (3 d)   | The same SSO session, since it last issued a code                                                                                                  |
| `AUTHORIZATION_CODE_TTL` | 120            | Authorization codes                                                                                                                                |
| `LOGIN_FLOW_TTL`         | 900 (15 min)   | The login, consent and org-select steps: their cookies and sessions, since a person fills them in                                                  |

Every redirect to a client's `redirect_uri` — the code, or an error from `/oauth/authorize`, the
login step or the consent screen — carries `iss`, the issuer (RFC 9207, built by
`authorizationResponseUrl` in `utils/authorization.ts`), and discovery advertises
`authorization_response_iss_parameter_supported`. `/oauth/authorize` answers JSON 400
`invalid_request` only until `client_id` and `redirect_uri` check out (an unknown client, an
unregistered redirect URI); after, every error goes to the redirect URI with `state` (RFC 6749
§4.1.2.1): `unsupported_response_type`, `unauthorized_client`, or `invalid_request` for any other
invalid parameter, such as a missing `state` or PKCE challenge or a `max_age` above 2147483647.

`/oauth/authorize` with `prompt=none` answers `login_required` when the SSO session is missing,
expired or idle, older than `max_age`, or belongs to a deactivated user. With `org_id` it issues the code
for that organization when the user may select it (`maySelectOrganization`, as the org switch
below), and answers `login_required` for one they may not. With `org_id`, the same cases fall
through to the password login. `max_age` is enforced there, at authorize: a code always carries a
login that satisfied it, and `/oauth/token` does not check it again. For core's own login client (`isFirstPartyClient` in `definitions/`) and for a client with
`consentRequired: false` asking for no `core:*` scope, `prompt=none` or an `org_id` switch with a
live session skips the consent screen and redirects with the code — unless the request says
`prompt=consent`, which shows the screen to every client but core's own. Any other client is answered `error=consent_required` (with `state`) at its `redirect_uri`
for `prompt=none` — consent is not remembered, and a silent request cannot show the consent screen
(OIDC Core 3.1.2.6) — and sent to `{UI}/consent` for an `org_id` switch. `prompt=login` goes to the password
login without touching the SSO session (any site can send a browser there); the login, once it
succeeds, continues that session or, for another user, replaces it — ending the other user's
session as a logout of this browser would, with every token family issued under it.

A request let in by the SSO session alone stays tied to it: the consent screen of an `org_id`
switch ends with that session, and the code is issued only while the session still exists, checked
under the user's lock that logout takes too; otherwise the client gets `error=login_required`. A
password change, an admin reset or any other sign-out of every session (`endUserSessions`) also
deletes the user's login steps already past the password — consent and organization picks, 2FA
verifications, 2FA setup grants, every 2FA setup session (those begun from the account page too),
identity link grants, provider round trips (an account-page link included) and authorization codes
not yet exchanged — so a password that has just been replaced cannot finish a login it started, nor
enrol a factor or link a provider. A sign-out that keeps the caller's browser keeps that browser's
SSO session, its consent for an org switch and its unexchanged codes. A step after the password check is
written only while that password is still the user's, holding the user's row as a token issue does
(`writeStepWhilePasswordIs` in `utils/firstFactor.ts`): a change that committed after the check
refuses the login as a wrong password would, and one in progress waits for the step and deletes it.
The 2FA step (`/oauth/totp/verify`, `/oauth/totp/recovery`) and 2FA setup (`/oauth/totp/setup`)
likewise consume their row in the transaction that writes the next step, under the same lock
(`writeStepConsuming` in `utils/db/loginFlows.ts`), so the row a sign-out deleted cannot be followed
by a step it missed. The consent and org-select submits consume theirs in the transaction that
issues the code (`consumeStep` of `issueAuthorizationCode`) or writes the consent step, after the
user's lock; a step already gone is `invalid_session`.

The SSO cookie and the 2FA setup token are random tokens stored only as their SHA-256
(`hashFlowToken`, in the db layer), as the consent, org-select and 2FA flow tokens are. So are
confidential-client secrets and refresh tokens (256 random bits each): a secret is checked by
hashing the presented one and comparing in constant time, and a refresh token is looked up by its
hash, so `/oauth/token`, `/oauth/revoke` and `/oauth/introspect` give an unauthenticated caller no
slow hash to make core compute. scrypt (`utils/password.ts`) is kept for the low-entropy secrets:
passwords, recovery codes and share passwords, stored as `scrypt$N$r$p$salt$key` so each hash names
its own cost. Passwords (login and share) use N=2^14, r=8, p=5 (OWASP's equivalent of 16 MiB at
p=1, with five times the CPU); recovery codes, 60 random bits each and all checked at a recovery
login, stay at p=1. Hashes from before the format (`salt:key`, N=2^14, r=8, p=1) still verify, topped
up to the current cost so an account on an old hash answers as slowly as an unknown email, and a
correct login password is stored again at the current parameters — conditionally on the hash read,
so a concurrent password change wins. Since the known-device cookie covers the password hash, that
one rehash voids the account's earlier known-device cookies; the login that rehashed gets a new one.
Every
password login gives the browser's SSO session a new token (session fixation); silent and org-switch
continuations keep it.

A WebSocket is authenticated once, at the handshake, with the token in `auth.token` (or an
`Authorization` header): a string of at most 8 KiB, else `Invalid access token`. The socket.io CORS
is not credentialed — no cookie is involved. It joins rooms for its user (`user:{id}`),
token (`token:{jti}`), session (`session:{refresh token id}`) and, for an organization's token,
`org:{orgId}` and `user:{id}:org:{orgId}`; a token that reaches the user's account (core's UI, a
service, or `core:account`) also `user:{id}:account`, and one that reaches core's files
`user:{id}:files`. Revoking the session or token closes it
(`notifySessionsRevoked`, `disconnectTokenSockets`), as do deactivating the user, removing them from
the organization or deactivating it (`disconnectUserSockets`, `disconnectOrganizationSockets` — the
sockets close even if ending the sessions then fails), and
the token's `exp`. Signing out everywhere revokes the families of the sessions it ends, so the
token of a session a refresh has rotated away, and its socket, go too. The UI reconnects with a fresh
token after a server-side close. The token is
checked once more after the socket joins its rooms, so a revocation landing mid-handshake still
closes it, and every `WEBSOCKET_REVALIDATE_INTERVAL_SECONDS` (default 60) each core process checks
its sockets' tokens in batches and closes those no longer active — whatever closed no socket when it
happened. One user may hold 20 sockets per core process, counted from the handshake
(`Too many connections` beyond that), and
a client message may be at most 16 KiB. A socket may send 10 messages at once and one a second after
that; more are dropped, and a client that keeps sending well past the rate is disconnected.

Events go out after the change commits (`websocket/emitters/`). A socket whose token reaches neither
the user's account nor core's files (`core:events` alone) gets only `auth:permissions:changed` and
the `auth:session:revoked` of its own session — nothing naming the user's other sessions,
organizations or buckets:

| Event                         | Payload                                 | Sent when                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth:permissions:changed`    | `{ reason, timestamp }`                 | to every socket of the user: their global roles change, or an admin changes a role they hold (a registry retirement is not notified; the UI sees it on its next token refresh)                                                         |
| `auth:session:revoked`        | `{ sessionId, timestamp }`              | to the account room and the session's own sockets: one of the user's sessions is revoked; its sockets close after                                                                                                                      |
| `auth:organization:changed`   | `{ reason, organizationId, timestamp }` | to the account room. `membership_changed`: added, removed, or member tier changed; `roles_changed`: org-scoped roles set; `org_deactivated`: to every member, after the organization's tokens are revoked and before its sockets close |
| `files:bucket-access:changed` | `{ bucketName, timestamp }`             | to the files room: a bucket grant was given to or revoked from the user (a member removal included), or the bucket's ownership moved to or from them (see [files.md](files.md))                                                        |

The UI refreshes its token on `auth:permissions:changed` and `auth:organization:changed`; a refresh
core rejects signs it out.

The login-flow pages (consent, org-select, 2FA) get the authorize request's parameters beside their
session token, only so that "Back to sign in" restarts `/oauth/authorize` for the client that began
the login. Core never reads them back.

`/oauth/end-session` with a valid `id_token_hint` logs this browser out at once, unless the browser
is signed in to that client as a different user than the hint's `sub` (`signedInAsOther`): any
site can hold an ID token of its own user, so that browser is asked to confirm as below. It then
redirects to
`post_logout_redirect_uri` or, for a navigation without one, to where the user signs in to the
client again (`clientSignInUrl`: the UI's root for core's own client, else the origin of its first
web redirect URI); the admin UI's own fetch gets JSON. A hint expired beyond
`ID_TOKEN_HINT_GRACE_SECONDS` vouches for nothing and is treated as none. Without one, it
ends nothing: it sets a one-time `tereo_logout_confirm_{client_id}` cookie and redirects to
`{UI}/logout`, whose confirm button posts the same token to `/oauth/end-session/confirm`. Only that
post, carrying the cookie (SameSite keeps it off cross-site posts), ends the session — so a
cross-site link cannot log anyone out.

Each user signed out writes a `LOGOUT` entry (`client_id`, the `sids` ended, the `sessionIds`
revoked, `method` `id_token_hint` or `confirm`) and an `auth.user.sessions-revoked` event in the
revoking transaction — none for a user of whom nothing was still live (a stale cookie, a repeated
logout).

The hourly `auth-cleanup` job (`jobs/authCleanup.ts`) deletes SSO, consent, org-selection and TOTP
sessions and TOTP setup grants once expired, and access tokens, refresh tokens and authorization
codes seven days past expiry (`AUTH_TOKEN_GRACE_MS`). Refresh tokens are deleted by expiry, never by
revocation: a revoked token is kept for the rest of its family's life so that replaying it still
revokes the family. A code is deleted only once no token of its family remains, since deleting it
cascades to them.

## Browser cookies

Core's cookies are per client (`{name}_{client_id}`): the refresh token (`trt_`, with
`refresh_token_response_mode=cookie`), the SSO session, each login step's session and the sign-out
confirmation; the known-device and identity-provider round-trip cookies are per browser. All are
httpOnly and `SameSite=Lax`. When they are Secure and `COOKIE_DOMAIN` is unset they are `__Host-`
cookies (`__Host-trt_{client_id}`, path `/`, no Domain), which the browser refuses from another host
or over http, so a sibling subdomain cannot plant or shadow them; otherwise (development over http,
or `COOKIE_DOMAIN` set) they are unprefixed and scoped to `/oauth`. Only `/oauth` handlers read
them; `/v1` authenticates by bearer token alone. The session indicator `tsi_{client_id}`, which
carries nothing and which the UI reads, is never prefixed. The refresh cookie lives as long as its
token family, not a fresh `JWT_REFRESH_TOKEN_TTL`. A cookie whose value is not a string (cookie-parser
turns a `j:` value into JSON) counts as missing.

**Origin binding.** SameSite=Lax keeps the cookies off cross-site posts, not off same-site ones from
another port or subdomain, and those carry every client's cookies. So a POST (or other unsafe
method) under `/oauth` that uses a client's cookie must come from core's own origin
(`PUBLIC_URL`), the UI's (`UI_BASE_URL`, which hosts every client's login pages), or an origin of
one of that client's registered redirect URIs — for core's own client `tereo-ui`, its callbacks
under `UI_BASE_URL`. `middleware/originCheck.ts` decides from `Sec-Fetch-Site` (`same-origin`
passes; anything but `same-site` uses no cookie) and `Origin`; a request with neither header is not
from a browser page and passes. The cookie getters in `utils/cookies.ts` refuse the rest with
`403 access_denied` when a handler reads them: refresh and revoke by cookie, the login submit,
consent, org selection, the 2FA steps, identity linking and the sign-out confirmation alike. A
request that authenticates otherwise (a secret, a code, a token in the body) is not affected by the
other clients' cookies it carries. `CORS_ALLOWED_ORIGINS` is only the CORS list: being on it lets a
page read core's API responses, not use another client's session. Credentialed CORS headers are not
sent on `GET /oauth/authorize`, which is navigated to (a fetch following its redirect could read
the code from the response URL), nor on the UI's pages.

## Deviations from the specs

Where core knowingly departs from OAuth 2.0 / OpenID Connect:

- **`email_verified` is not always `true`.** It reports whether the address was proven
  ([Email verification](#email-verification)): by a verify link, a reset link, first-admin setup,
  or a provider that vouches for it. An address an admin set or changed is unverified until then. Core does not require
  it for sign-in.
- **`sid` means two things.** In an access token it is the refresh token's id (the token family's
  session, which `/v1/account/sessions` and the WebSocket rooms use); in an ID token it is the SSO
  session (the browser), as OIDC Front-/Back-Channel Logout intend. The UI and the SDK depend on
  both.
- **`offline_access` is not required for a refresh token.** One is issued to every client with the
  `refresh_token` grant type.
- **`state` is required** on `/oauth/authorize`, as is PKCE with `S256` (`plain` is refused).
- **`prompt=consent` is ignored for core's own login client**, `tereo-ui`, which has no consent
  screen: it acts in core as the user with the user's full rights, and the user is signing in to
  core itself. Every other client is shown the screen.
- **`prompt=select_account`** is accepted and ignored (a browser holds one account per client), so
  discovery does not advertise it. `prompt` is a space-separated list; `none` with any other value is
  `400 invalid_request`.
- **`/oauth/revoke` without a token** — neither `token` nor the `trt_{client_id}` cookie — is
  `400 invalid_request` (RFC 7009 makes `token` required). A token that is unknown, already revoked
  or another client's is still `200`.

## Rate limits

All in Redis; limiters in `utils/rateLimit.ts`, instances in `middleware/rateLimit.ts` except `clientSecretFailure`, which lives with client authentication in `utils/auth.ts`. The client-facing numbers are in the spec's _Rate Limiting_ section.

"Per IP" means per `getIpIdentifier` (`ipRateLimitKey`): an IPv4 address as is, an IPv4-mapped IPv6 address as its IPv4 address, and any other IPv6 address as its /64, since one host is often given a whole /64 to rotate through. The share unlock window (`utils/shareUnlockLimiter.ts`) still keys by the full address.

- **Before authentication** — `rateLimitPreAuth`, per client IP, mounted ahead of `requireAuth` on `/v1/admin`, `/v1/account`, `/v1/files`, `/v1/audit`, `/v1/webhooks` and `/v1/notifications`, so floods of missing or bad tokens are bounded without verifying them.
- **General** — `rateLimitGeneral`, after authentication: per user, per IP when anonymous, per OAuth client for internal service accounts.
  - **Defaults** come from `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_INTERNAL_PER_SECOND`, `RATE_LIMIT_PRE_AUTH_PER_SECOND` and `RATE_LIMIT_PRE_AUTH_INTERNAL_PER_SECOND` (see [configuration](configuration.md)). A pre-auth value below its general counterpart would make the general limit unreachable, so startup fails.
  - **Per-user override** — `auth.users.rate_limit_per_second` (`rateLimitPerSecond`, 1–100000) replaces the caller's tier default, internal or external; null means the default. It never applies to anonymous requests. It is set with `PATCH /v1/admin/users/:id`, `/v1/admin/services/:id` and `/v1/admin/integrations/:id`, in the admin UI, and for provisioned services and integrations in the provisioning document (omitting it clears it). A change is audited and emitted as `auth.user.rate-limit-changed`. Lowering it takes effect on the next request, which is refused if the caller's count is already above the new value. Changing another user's limit through `PATCH /v1/admin/users/:id` needs `users.write` and is refused (403) when the target holds any permission the caller does not, as deactivation is; changing your own is allowed.
  - **Pre-auth caveat** — the per-IP pre-auth limit applies before the override is known, so an override above it does not help a single-IP external caller: raise `RATE_LIMIT_PRE_AUTH_PER_SECOND` as well. The active values are in `GET /v1/admin/settings` (`rateLimits`).
- **Credentials** — counted before the credential is checked, atomically, and cleared by a success: login passwords per client and IP (`authFailure`, keyed by the body's `client_id` once that client is found — never by a header the login does not authenticate with, which a caller could vary per request; the key spans every account tried from that address, so a success only gives back its own attempt — clearing the count would let a login to one's own account wipe the failures against everyone else's) and per account (`loginAccountBackoff`: keyed on a hash of the normalised email, so unknown emails behave the same; five attempts, then a delay doubling from 1 s to 15 min — a backoff, not a lockout); provider callbacks per IP once their round trip is consumed (see _Errors_ under _Sign in with an identity provider_); confidential-client secrets at `/oauth/token`, `/oauth/revoke` and `/oauth/introspect` per client and IP (`clientSecretFailure`: 10 wrong secrets per 5 min, keyed with the IP so one address cannot lock a client out for its other callers. Unlike the others it counts only failures — read before the secret is hashed, spent after a wrong one — so any number of concurrent correct secrets from one address, such as pods behind one NAT, pass. Once the count is full every attempt is refused before hashing, the right secret included, until the window expires: a correct secret cannot clear a full count, so a stale-secret pod sharing an address can hold the client off for up to 5 min. Concurrent wrong secrets can overshoot the limit by the burst, acceptable for high-entropy secrets); login 2FA setup per user; `/v1/account/password` and `/v1/account/totp/*` per user; setup per IP; share unlock per token and IP.
- **Login 2FA** — `/oauth/totp/verify` and `/oauth/totp/recovery` share `totpBackoff`, per user, which nothing resets: a sliding 24-hour window (`createWindowedBackoffLimiter`) in which five attempts pass, then each next one waits a delay after the last that doubles from 1 s to an hour. Each attempt is spent before the code is checked; a right code takes back only its own, so the owner signing in hands an attacker who holds the password no fresh guesses, and the attacker gets some forty guesses a day at most. From the fifth attempt in the window every failure writes an audit entry (`User`, action `UPDATE`, `metadata.action` `totp_failures`, with `method` and `recentFailures`). The trade-off is the owner's access while an attacker keeps the delay at its cap: a browser holding the user's known-device cookie (set by a completed login) is let through the delay, its attempts still counting toward it, capped at 5 per hour per cookie (`knownDeviceTotp`); a browser without one competes with the attacker for the next attempt, at most an hour away, so an attacker who spends each one as it opens can keep the owner out until they sign in from a known device or an admin resets the password. A per-2FA-session limit would add nothing, since the password buys a new session. The setup verify (`/oauth/totp/setup/verify`), whose caller holds the secret, keeps a fixed 5 per 300 s per user (`totpSetupFailure`).
- **Wrong passwords** — every failed password check at `POST /oauth/authorize` and `POST /v1/account/password` is logged (`authLog` `password_failure`: user, client, IP, `check` and `reason` — `unknown_user`, `login_not_allowed`, `no_password` or `invalid_password` — never what was typed). For an existing user, `utils/passwordAttempts.ts` counts the failures in a row in Redis (both routes share the count; a correct password clears it, and it lapses after 24 hours without a failure), and from the fifth each one writes an audit entry (`User`, action `UPDATE`, `metadata.action` `password_failures`, with `check`, `reason` and `consecutiveFailures`). An email no account has is only logged.
- **Known device** — so that someone holding an account in backoff does not lock its owner out, a completed login (after 2FA when required) sets `tereo_known_device` (`utils/knownDevice.ts`; httpOnly, `SameSite=Lax`, path `/oauth` or a `__Host-` cookie as in [Browser cookies](#browser-cookies), 90 days): `<userId>.<issuedAt>.<HMAC>`, keyed with `KNOWN_DEVICE_KEY` and covering the user's password hash, so a password change or admin reset (a freshly salted hash) voids every earlier cookie with no extra column. At the login submit, while the account is delayed (`loginAccountBackoff.isDelayed`), a cookie valid for that same user skips the delay: `authFailure` and the password check still apply, the attempt still counts toward the account (`spendUnblocked`, which lengthens the delay without being refused by it), and `knownDeviceFailure` caps it at 5 wrong passwords per 15 min per cookie, so a stolen cookie is not an unlimited guess. Outside a delay a known device is treated like any browser. The cookie is checked only against the user the email names, so it reveals nothing about other emails; sign-out leaves it, since it is not a session.
- **Redis down** — credential limiters fail closed with `503 temporarily_unavailable`, except `clientSecretFailure`, which fails open: the secret is still verified, and client authentication (`/oauth/token`, `/oauth/revoke`, `/oauth/introspect`) must not go down with Redis; the general and pre-auth limiters fail open, so an outage does not take the API down. None waits in ioredis's offline queue: each refuses (or passes) at once while the client is not ready.
- **Tests** run every limiter at its production limits. `tests/setup/setup.ts` clears limiter keys before each test; a test needing several client addresses sends `X-Forwarded-For`, trusted from loopback by the default `TRUST_PROXY`.

`authLog` (`utils/audit.ts`) logs failures (wrong passwords included) and code/refresh-token reuse at `warn`, successes at `info`, and per-request and introspection lines at `debug`.

## Pagination

Admin list endpoints (`GET /v1/admin/users`, `/v1/admin/clients`, `/v1/admin/roles`, `/v1/admin/permissions`, `/v1/admin/organizations`) use **cursor-based keyset pagination**. Response shape: `{ data, hasMore, limit, nextCursor }`. Cursors are HMAC-signed opaque strings (the shared `CURSOR_SIGNING_KEY_V{n}`) bound to the list that minted them (its request path) and the requested `sort`+`sortDir`; tampering, or replay on another list or sort, returns `400 invalid_cursor`. No `total` count — `COUNT(*)` is not cheap at scale. Pass `cursor=<nextCursor>` from the prior page to advance; first request omits the cursor.

The cursor signing key is intentionally separate from the OAuth2 JWT signing keys (`JWT_SIGNING_KEY_V{n}`, or `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` from env; see [configuration](configuration.md#jwt-signing-keys)) — JWT keys are RSA, used for asymmetric token signing; the cursor key is symmetric HMAC for opaque page-cursor MAC tags. It is generated into `core.secrets` on first start unless set in env (32 bytes, base64). Rotate via `CURSOR_SIGNING_KEY_V2` + bumping `CURSOR_ACTIVE_SIGNING_KEY_VERSION` to `2`; existing V1 cursors keep validating against V1 until they expire from client state.

## Seeding

`src/scripts/seed.ts` runs after every migrate (the compose `migrate` service, or your deploy's migrate
step). It creates only what code cannot declare: the OIDC scopes, the system user, the default
login client and the default organization, plus the first partitions. Core's permissions, system
roles, bucket and event types are registered by core itself on every start
(`utils/coreRegistration.ts`). No person is created; the first admin comes from setup.

## Commands

From `packages/tereo`:

```bash
npm run dev                # Core with hot reload, port 4001
npm run check              # Type check
npm run db:generate        # Generate Prisma client
npm run db:migrate         # Create a migration from schema.prisma (doesn't apply it)
npm run db:migrate:deploy  # Apply migrations
npm run db:seed            # Seed (idempotent)
npm test                   # Tests in Docker (npm run test:unit / test:int for local vitest)
```
