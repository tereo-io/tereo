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

Core's own resource routes — `/v1/account`, `/v1/admin`, `/v1/files`, `/audit`, `/webhooks` and
the `/ws` socket — admit a bearer token by the client it was issued to (`utils/coreAccess.ts`,
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

| Scope                                  | Area                 | Ceiling                                                                                                  |
| -------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `core:account`                         | `/v1/account`, `/ws` | — (the user's own account)                                                                               |
| `core:admin` / `core:admin.read`       | `/v1/admin`          | `users`, `roles`, `permissions`, `clients`, `settings`, `organizations`, `services` — `.admin` / `.read` |
| `core:files` / `core:files.read`       | `/v1/files`          | `file-service.admin` / the four `file-service.*.read`                                                    |
| `core:audit` / `core:audit.read`       | `/v1/audit`          | `audit-logs.admin` / `audit-logs.read`                                                                   |
| `core:webhooks` / `core:webhooks.read` | `/v1/webhooks`       | `webhooks.admin` / `webhooks.read`, `webhooks.event-types.read`                                          |
| `core:events`                          | `/ws`                | — (the socket only: permission-change pushes, nothing else)                                              |
| `core:organizations`                   | `GET /v1/account/organizations` | `organizations.support-access` ([Support access](#support-access))                            |

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

Outside core's resource routes:

- `/oauth/userinfo` is the OIDC endpoint every relying party uses: any active user access token
  carrying `openid` (otherwise 403 `insufficient_scope` with a `scope="openid"` challenge), with
  `profile`/`email` claims by scope. `roles`, `permissions` and `organizations` — core's
  authorization — are included only for a token that is not `none` above (the UI, a service's
  client, or a core API scope); any other relying party gets the OIDC claims (and `org_id`/`org_name`
  for the token's organization) without them.
- `/oauth/introspect` answers app services (the token's own client, or a service in its audience),
  and only confidential clients, by HTTP Basic: a public client's `client_id` authenticates nothing,
  so it is 401 `invalid_client` (discovery lists `client_secret_basic` alone).
  `sub` is the token's own: the user's id, or a client_credentials token's `client_id`. `user_id`
  names the user the token acts as — the user, or the client's service-account user — so an app
  can record either kind as an actor in `auth.users`.
  It reports `permissions` as the user's live permissions, unchanged: core's ceilings govern core's
  API only, and an app enforces its own scopes. An app introspecting a third-party token therefore
  sees the user's permissions, as it would have before; whether it honours that token for its own
  API is the app's decision, which `scope` and `aud` in the response inform. A client that is not a
  service's, introspecting its own token whose access is `none`, is not told them, as at userinfo.
- `/oauth/check-permission` authenticates a confidential client, not a token. A client of an
  organization may only ask about that organization's members, and is answered in it;
  `organization_id`, if given, must be the client's; a non-member and an unknown user get the same 403. An organization-bound
  [integration](integrations.md) is such a client, answered for its organization's members. A
  client of no organization must be a service's (a platform integration is refused): it is
  answered from the user's global roles only and may not name an organization. Any other client — a login client created under
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

Revoking a refresh token at `/oauth/revoke` ends its whole family, a successor rotated from it
included, and the SSO session it was issued under (`endSession`), under the same session-end lock
a refresh takes, so a refresh racing the revocation cannot leave a live successor.

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
but only for a request with no `core:*` scope. A request for any core scope always shows the
consent screen (and `prompt=none` gets `consent_required`), since those scopes act in core's API as
the user. Core's own login client always skips it, so the admin UI shows no consent screen after a
password login. The user still signs in, and the client still gets only the scopes it is registered
for. Core's own login client never asks and refuses a change to either field. Both
fields can come from the [provisioning file](provisioning.md), whose clients are read-only here
(`409 managed_by_provisioning`).

**Listing clients.** `clients.read` is not scoped by organization or owner: `GET /v1/admin/clients`
and `GET /v1/admin/clients/:id` show every client — services', organizations' and login clients
alike — with their metadata (name, type, redirect URIs, scopes, grant types, audience, owner,
organization, service). No secret is ever returned; a client secret is shown once, when it is
created or regenerated. Grant `clients.read` with that in mind.

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
| `ssoOnly`    | Password sign-in is refused for users at this domain.                                                                                                                                                       |

They combine freely: "staff must use Google, and nobody joins automatically" is `ssoOnly` without
`autoAccept`. Default roles must be roles assignable within an organization, and the admin setting
them must be able to grant them, as when assigning roles to a user. Domains are managed at
`/v1/admin/identity-providers/{id}/domains`; `PATCH` changes only the fields sent, and `roleIds`
replaces the set (roles the domain already hands out skip the grant check, except when the `PATCH`
moves the domain to another organization: then every role it will hand out there, sent or kept, is
checked against that organization). Setting `ssoOnly: true` (on create or `PATCH`) is refused with 409
`provider_inactive` while the provider is deactivated, since its users would have no way in.
Deleting a custom role removes it from every domain's default roles.

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

1. The identity is already linked: it signs in that user.
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

An admin creates a user without a password (`POST /v1/admin/users` takes an optional `password`; the
user reads `hasPassword: false`) and issues an invite for a provider with
`POST /v1/admin/users/{id}/identity-invites` (`{ providerId }`). The first sign-in with that provider
whose verified email matches the user's claims the invite, once. Invites last 7 days, issuing again
for the same provider replaces the old one and restarts the 7 days, and one is removed when the user
links that provider another way. `GET /v1/admin/users/{id}/identities` lists the user's identities and
outstanding invites (an expired one is listed until the hourly cleanup removes it; check
`expiresAt`), and `DELETE …/identity-invites/{providerId}` withdraws one. Changing a user's email
withdraws all of their outstanding invites, because an invite is matched by email and must not
follow the account to an address the issuing admin never saw. Core sends no email: tell the user to
"Sign in with <provider>".

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
`last_sign_in_method` when the user has no password and it is their only identity, and with 409
`sso_required` when their email's domain is `ssoOnly` for that provider. An admin can unlink with
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
| `upstream_failed`                        | The provider returned an error, or the code exchange or ID token validation failed (logged with the cause)                                                                                                                                   |
| `session_expired`                        | No or mismatched `upstream_auth` cookie, or an unknown, used or expired round trip (10 minutes), or no authorize session cookie at start; for a link grant, a missing cookie, a used or expired grant, or another provider than the domain's |
| `provider_inactive`                      | The provider was deactivated before or during the flow                                                                                                                                                                                       |
| `no_account`                             | No linked identity, no invite, and no auto-accept domain of this provider (also: no email claim, or the domain's organization is archived or inactive)                                                                                       |
| `account_exists`                         | An auto-accept domain matched, but an account already has that email (or the invited user already has an identity at this provider)                                                                                                          |
| `email_unverified`                       | An invite or domain would match, or a forced link is completing, but the provider did not verify the email (or Google's `hd` did not match)                                                                                                  |
| `account_inactive`                       | The user is deactivated, or is a service account                                                                                                                                                                                             |
| `account_mismatch`                       | Forced link: the provider account's verified email is not the user's                                                                                                                                                                         |
| `identity_in_use`, `already_linked`      | Linking, on `/account?error=`, or an SSO-only user's forced link on `/login`: the provider account belongs to another user, or the user already has this provider (or this account)                                                          |
| `sso_required`                           | Password sign-in for an SSO-only domain whose provider the user has linked (403 JSON from the password POST, with `provider`); also 409 from account and admin unlink of the provider an SSO-only domain requires                            |
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

Changing a role itself takes its permissions from every holder at once, so deleting a role
(`DELETE /v1/admin/roles/:id`), deactivating it (`PATCH` with `isActive: false`) and dropping
permissions from it (`PUT /v1/admin/roles/:id/permissions`) need the caller's global permissions to
cover every permission taken away (`assertCanTakeAway`) — otherwise 403 naming those lacking.

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
user, a service account or an inactive user is refused with 400 `user_not_addable`. An org admin
does not manage an owner: changing an owner's tier (`PATCH …/members/:userId`) or roles
(`PUT …/members/:userId/roles`) needs an owner or `organizations.write` (403 otherwise).

**Scope of roles.** `GET /v1/account/me` and `/oauth/userinfo` list the same roles that give their
permissions: global ones plus the token's organization's, unexpired, of an active, unarchived,
unretired role.

## Two-factor authentication (TOTP)

The `totpPolicy` system setting (`PATCH /v1/admin/settings`) is `disabled`, `optional` (the default) or
`required`:

- `required` — every user must enrol; login redirects to setup until they do.
- `optional` — users may enrol; a user holding an active role with `requires2fa` must.

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
enrol from `POST /v1/account/totp/setup`, which acts on the token's user.

A TOTP code is accepted once. `auth.users.totp_last_window` holds the 30-second step of the last
code accepted for the user's secret; every check — the 2FA step at login, both setup verifies, and
`DELETE /v1/account/totp` and `POST /v1/account/totp/recovery-codes` — refuses a code from that step or
an earlier one with 401 `invalid_code`, and records the new step with a conditional update, so two
concurrent submissions of one code cannot both pass. Disabling TOTP clears it. Recovery codes are
single-use on their own and do not touch it.

The login flow's 2FA, org-select and consent sessions (`auth.totp_verifications`,
`auth.org_selection_sessions`, `auth.consent_sessions`) are found by the SHA-256 of their token, as
the setup grant is; the URL and the cookie carry the token itself.

Enabling and disabling are audited (`User`, action `UPDATE`, `metadata.action` `totp_enabled` /
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
event); an admin resetting their own password keeps the session they act from. Every such sign-out
also revokes the access tokens issued without a refresh token (clients without the `refresh_token`
grant), all but the caller's own, and closes their sockets. An app service using `@tereo-io/sdk`
may cache an active introspection for up to 60 s (its `introspectionCacheTtlSeconds`), so it can
keep accepting a signed-out or revoked token that long. Either reset, an
email change, an identity invite or an admin identity unlink
(`DELETE /v1/admin/users/:id/identities/:identityId`) hands the caller the account or changes how it
is entered, so it may not reach beyond what the caller holds (`assertMayResetCredentials`): every permission the user holds — through global roles
and through roles in any organization, active or not (an org-scoped role grants only its
org-assignable permissions), counting deactivated roles too, since an admin can reactivate one
(archived and retired ones do not count) — must be covered, hierarchically, by the caller's global permissions,
cut down to their token's scope ceiling for a delegated token. The caller's org-scoped roles do not
count, since the account reaches beyond that organization. Otherwise 403, naming the permissions the
caller lacks: `users.write` alone resets only users who hold no more than `users.write`, and no
third-party client's token (no core API scope reaches `admin`) resets an administrator. The system user and a service's account are refused, as on the other
admin user routes.

This check and `assertMayDisempower` run inside the change's transaction, under a per-user advisory lock
(`db.users.lockAuthority`) that every admin change to the user's roles — global or in an organization,
membership removal included — takes too, first: a role granted to the user concurrently is either
committed before the check sees it, or waits until the reset or removal has committed. Editing a
role's permissions or restoring a role does not take it, so a role the user already holds can still
gain permissions while the check runs.

## Session lifetimes

Every lifetime is absolute — using a session never extends it:

| Setting                  | Default        | What it bounds                                                                                                                                     |
| ------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_TOKEN_TTL`   | 3600 (1 h)     | Access and ID tokens                                                                                                                               |
| `JWT_REFRESH_TOKEN_TTL`  | 2592000 (30 d) | A refresh-token family, from the code exchange. A rotated token keeps the family's original expiry                                                 |
| `USER_SESSION_TTL`       | 604800 (7 d)   | The SSO session behind `prompt=none` and org switching (`org_id`). A session continued without a password keeps the expiry of the one it came from |
| `AUTHORIZATION_CODE_TTL` | 120            | Authorization codes                                                                                                                                |
| `LOGIN_FLOW_TTL`         | 900 (15 min)   | The login, consent and org-select steps: their cookies and sessions, since a person fills them in                                                  |

Every redirect to a client's `redirect_uri` — the code, or an error from `/oauth/authorize`, the
login step or the consent screen — carries `iss`, the issuer (RFC 9207, built by
`authorizationResponseUrl` in `utils/authorization.ts`), and discovery advertises
`authorization_response_iss_parameter_supported`.

`/oauth/authorize` with `prompt=none` answers `login_required` when the SSO session is missing,
expired, older than `max_age`, or belongs to a deactivated user. With `org_id`, the same cases fall
through to the password login. `max_age` is enforced there, at authorize: a code always carries a
login that satisfied it, and `/oauth/token` does not check it again. For core's own login client (`isFirstPartyClient` in `definitions/`) and for a client with
`consentRequired: false` asking for no `core:*` scope, `prompt=none` or an `org_id` switch with a
live session skips the consent screen and redirects with the code. Any other client is answered `error=consent_required` (with `state`) at its `redirect_uri`
for `prompt=none` — consent is not remembered, and a silent request cannot show the consent screen
(OIDC Core 3.1.2.6) — and sent to `{UI}/consent` for an `org_id` switch. `prompt=login` goes to the password
login without touching the SSO session (any site can send a browser there); the login, once it
succeeds, continues that session or, for another user, replaces it.

A request let in by the SSO session alone stays tied to it: the consent screen of an `org_id`
switch ends with that session, and the code is issued only while the session still exists, checked
under the user's lock that logout takes too; otherwise the client gets `error=login_required`. A
password change, an admin reset or any other sign-out of every session (`endUserSessions`) also
deletes the user's login steps already past the password — consent and organization picks, 2FA
verifications, 2FA setup grants and the setups they began, identity link grants — so a password
that has just been replaced cannot finish a login it started. A step after the password check is
written only while that password is still the user's, holding the user's row as a token issue does
(`writeStepWhilePasswordIs` in `utils/firstFactor.ts`): a change that committed after the check
refuses the login as a wrong password would, and one in progress waits for the step and deletes it.
The 2FA step (`/oauth/totp/verify`, `/oauth/totp/recovery`) and 2FA setup (`/oauth/totp/setup`)
likewise consume their row in the transaction that writes the next step, under the same lock
(`writeStepConsuming` in `utils/db/loginFlows.ts`), so the row a sign-out deleted cannot be followed
by a step it missed.

The SSO cookie and the 2FA setup token are random tokens stored only as their SHA-256
(`hashFlowToken`, in the db layer), as the consent, org-select and 2FA flow tokens are. So are
confidential-client secrets and refresh tokens (256 random bits each): a secret is checked by
hashing the presented one and comparing in constant time, and a refresh token is looked up by its
hash, so `/oauth/token`, `/oauth/revoke` and `/oauth/introspect` give an unauthenticated caller no
slow hash to make core compute. scrypt (`utils/password.ts`) is kept for the low-entropy secrets:
passwords, recovery codes and share passwords. Every
password login gives the browser's SSO session a new token (session fixation); silent and org-switch
continuations keep it.

A POST under `/oauth` carrying core's credential cookies must come from core, the UI or
`CORS_ALLOWED_ORIGINS` (`middleware/originCheck.ts`: `Sec-Fetch-Site`, else `Origin`; neither
header passes). SameSite=Lax keeps the cookies off cross-site posts, not off same-site ones from
another port or subdomain.

A WebSocket is authenticated once, at the handshake. It joins rooms for its user (`user:{id}`),
token (`token:{jti}`), session (`session:{refresh token id}`) and, for an organization's token,
`org:{orgId}` and `user:{id}:org:{orgId}`. Revoking the session or token closes it
(`notifySessionsRevoked`, `disconnectTokenSockets`), as do deactivating the user, removing them from
the organization or deactivating it (`disconnectUserSockets`, `disconnectOrganizationSockets`), and
the token's `exp`. The UI reconnects with a fresh token after a server-side close. The token is
checked once more after the socket joins its rooms, so a revocation landing mid-handshake still
closes it. One user may hold 20 sockets per core process (`Too many connections` beyond that), and
a client message may be at most 16 KiB.

Events go to the user's room, after the change commits (`websocket/emitters/`):

| Event                       | Payload                                 | Sent when                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth:permissions:changed`  | `{ reason, timestamp }`                 | the user's global roles change, or an admin changes a role they hold (a registry retirement is not notified; the UI sees it on its next token refresh)                                                            |
| `auth:session:revoked`      | `{ sessionId, timestamp }`              | one of the user's sessions is revoked; its sockets close after                                                                                                                                                    |
| `auth:organization:changed` | `{ reason, organizationId, timestamp }` | `membership_changed`: added, removed, or member tier changed; `roles_changed`: org-scoped roles set; `org_deactivated`: to every member, after the organization's tokens are revoked and before its sockets close |
| `files:bucket-access:changed` | `{ bucketName, timestamp }` | a bucket grant was given to or revoked from the user (a member removal included), or the bucket's ownership moved to or from them (see [files.md](files.md)) |

The UI refreshes its token on `auth:permissions:changed` and `auth:organization:changed`; a refresh
core rejects signs it out.

The login-flow pages (consent, org-select, 2FA) get the authorize request's parameters beside their
session token, only so that "Back to sign in" restarts `/oauth/authorize` for the client that began
the login. Core never reads them back.

`/oauth/end-session` with a valid `id_token_hint` logs this browser out at once. Without one, it
ends nothing: it sets a one-time `tereo_logout_confirm_{client_id}` cookie and redirects to
`{UI}/logout`, whose confirm button posts the same token to `/oauth/end-session/confirm`. Only that
post, carrying the cookie (SameSite keeps it off cross-site posts), ends the session — so a
cross-site link cannot log anyone out.

The hourly `auth-cleanup` job (`jobs/authCleanup.ts`) deletes SSO, consent, org-selection and TOTP
sessions and TOTP setup grants once expired, and access tokens, refresh tokens and authorization
codes seven days past expiry (`AUTH_TOKEN_GRACE_MS`). Refresh tokens are deleted by expiry, never by
revocation: a revoked token is kept for the rest of its family's life so that replaying it still
revokes the family. A code is deleted only once no token of its family remains, since deleting it
cascades to them.

## Deviations from the specs

Where core knowingly departs from OAuth 2.0 / OpenID Connect:

- **`email_verified` is always `true`.** There is no verification column: an email is set by an
  admin (or an invite) or comes from an identity provider that verified it.
- **`sid` means two things.** In an access token it is the refresh token's id (the token family's
  session, which `/v1/account/sessions` and the WebSocket rooms use); in an ID token it is the SSO
  session (the browser), as OIDC Front-/Back-Channel Logout intend. The UI and the SDK depend on
  both.
- **`offline_access` is not required for a refresh token.** One is issued to every client with the
  `refresh_token` grant type.
- **`state` is required** on `/oauth/authorize`, as is PKCE with `S256` (`plain` is refused).
- **`prompt=select_account`** is accepted and ignored (a browser holds one account per client), so
  discovery does not advertise it. `prompt` is a space-separated list; `none` with any other value is
  `400 invalid_request`.
- **`/oauth/revoke` without a token** — neither `token` nor the `trt_{client_id}` cookie — is
  `400 invalid_request` (RFC 7009 makes `token` required). A token that is unknown, already revoked
  or another client's is still `200`.

## Rate limits

All in Redis; limiters in `utils/rateLimit.ts`, instances in `middleware/rateLimit.ts` except `clientSecretFailure`, which lives with client authentication in `utils/auth.ts`. The client-facing numbers are in the spec's _Rate Limiting_ section.

"Per IP" means per `getIpIdentifier` (`ipRateLimitKey`): an IPv4 address as is, an IPv4-mapped IPv6 address as its IPv4 address, and any other IPv6 address as its /64, since one host is often given a whole /64 to rotate through. The share unlock window (`utils/shareUnlockLimiter.ts`) still keys by the full address.

- **Before authentication** — `rateLimitPreAuth`, per client IP, mounted ahead of `requireAuth` on `/v1/admin`, `/v1/account`, `/v1/files`, `/audit` and `/webhooks`, so floods of missing or bad tokens are bounded without verifying them.
- **General** — `rateLimitGeneral`, after authentication: per user, per IP when anonymous, per OAuth client for internal service accounts.
- **Credentials** — counted before the credential is checked, atomically, and cleared by a success: login passwords per client and IP (`authFailure`, keyed by the body's `client_id` once that client is found — never by a header the login does not authenticate with, which a caller could vary per request; the key spans every account tried from that address, so a success only gives back its own attempt — clearing the count would let a login to one's own account wipe the failures against everyone else's) and per account (`loginAccountBackoff`: keyed on a hash of the normalised email, so unknown emails behave the same; five attempts, then a delay doubling from 1 s to 15 min — a backoff, not a lockout); provider callbacks per IP once their round trip is consumed (see _Errors_ under _Sign in with an identity provider_); confidential-client secrets at `/oauth/token`, `/oauth/revoke` and `/oauth/introspect` per client and IP (`clientSecretFailure`: 10 wrong secrets per 5 min, keyed with the IP so one address cannot lock a client out for its other callers. Unlike the others it counts only failures — read before the secret is hashed, spent after a wrong one — so any number of concurrent correct secrets from one address, such as pods behind one NAT, pass. Once the count is full every attempt is refused before hashing, the right secret included, until the window expires: a correct secret cannot clear a full count, so a stale-secret pod sharing an address can hold the client off for up to 5 min. Concurrent wrong secrets can overshoot the limit by the burst, acceptable for high-entropy secrets); login 2FA per user; `/v1/account/password` and `/v1/account/totp/*` per user; setup per IP; share unlock per token and IP.
- **Known device** — so that someone holding an account in backoff does not lock its owner out, a completed login (after 2FA when required) sets `tereo_known_device` (`utils/knownDevice.ts`; httpOnly, `SameSite=Lax`, path `/oauth`, 90 days): `<userId>.<issuedAt>.<HMAC>`, keyed with `KNOWN_DEVICE_KEY` and covering the user's password hash, so a password change or admin reset (a freshly salted hash) voids every earlier cookie with no extra column. At the login submit, while the account is delayed (`loginAccountBackoff.isDelayed`), a cookie valid for that same user skips the delay: `authFailure` and the password check still apply, the attempt still counts toward the account (`spendUnblocked`, which lengthens the delay without being refused by it), and `knownDeviceFailure` caps it at 5 wrong passwords per 15 min per cookie, so a stolen cookie is not an unlimited guess. Outside a delay a known device is treated like any browser. The cookie is checked only against the user the email names, so it reveals nothing about other emails; sign-out leaves it, since it is not a session.
- **Redis down** — credential limiters fail closed with `503 temporarily_unavailable`; the general and pre-auth limiters fail open, so an outage does not take the API down. None waits in ioredis's offline queue: each refuses (or passes) at once while the client is not ready.
- **Tests** run every limiter at its production limits. `tests/setup.ts` clears limiter keys before each test; a test needing several client addresses sends `X-Forwarded-For`, trusted from loopback by the default `TRUST_PROXY`.

`authLog` (`utils/audit.ts`) logs failures and code/refresh-token reuse at `warn`, successes at `info`, and per-request and introspection lines at `debug`.

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
npm test                   # Tests in Docker (npm run test:local for local vitest)
```
