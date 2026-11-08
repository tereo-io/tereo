# Sign-in page branding

Core's sign-in pages (`/login`, `/consent`, `/logout`, `/set-password` and the steps under `/login/*`)
say "Tereo" in kosmeo's stock colours until an admin brands them. Branding is made of fixed slots,
set per client, with a default beneath; no free-form HTML or CSS reaches the page. It is set in the
admin UI (**Branding**), through `/v1/admin/branding`, or by a
[provisioning document](provisioning.md#branding). The route reference is in the API docs
(`/docs`, tag _Admin - Branding_).

## Slots

| Slot                        | Type    | Limits                                                                                                                                                                                                                |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appName`                   | text    | 60 characters. Replaces "Tereo" in page titles and `<title>` (and the console header, see below)                                                                                                                      |
| `headline`, `subtitle`      | text    | 80 / 160. The login page's heading and subheading                                                                                                                                                                     |
| `signInLabel`               | text    | 30. The login button                                                                                                                                                                                                  |
| `notice`                    | text    | 280. Plain text above the login form                                                                                                                                                                                  |
| `logo`, `logoDark`          | image   | PNG, WebP, JPEG, SVG; `BRANDING_IMAGE_MAX_SIZE_KB` (512 KB). `logoDark` shows under the app's dark theme (its theme setting, not the OS's); without one, `logo` shows in both                                         |
| `favicon`                   | image   | PNG, SVG, ICO; `BRANDING_IMAGE_MAX_SIZE_KB` (512 KB)                                                                                                                                                                  |
| `background`                | image   | PNG, WebP, JPEG; `BRANDING_BACKGROUND_MAX_SIZE_MB` (5 MB)                                                                                                                                                             |
| `layout`                    | enum    | `centered` (card over a full-bleed background) or `split` (the background in its own column beside a solid form column; below 48rem only the form shows, and the editor's preview applies that against its own width) |
| `footerLinks`               | list    | Up to 3 `{ label, url }`; label 40 characters; `url` must be `https:`                                                                                                                                                 |
| `colorsLight`, `colorsDark` | map     | `--k-*` variable to colour value                                                                                                                                                                                      |
| `applyToConsole`            | boolean | Applies the colours and app name to the admin console (see below)                                                                                                                                                     |

Text is rendered as text, never HTML. Every slot is nullable and `null` means inherit. The steps
other than login (2FA, org select, change password, consent, logout, set password) take the app
name, logos, favicon, colours, layout, background and footer links and keep their stock wording.

**Colours.** The keys are the 51 `--k-*` custom properties of `@kosmeo-ui/react` whose name has
`color` or `shadow` (`src/definitions/brandingTokens.ts`; a conventions test keeps it equal to the
installed stylesheet). A value is `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or `rgb()`, `rgba()`,
`hsl()`, `hsla()`, `oklch()` holding only numbers (optionally signed, so a hue may be negative, each
optionally followed by `%` or `deg`) separated by spaces, commas or `/`, at most 64 characters. Values are written into an injected `<style>`, so nothing else is accepted: no
`var()`, `url()`, keywords, comments, quotes or `;{}`.

## Inheritance

Client profile, then the default profile, then stock Tereo, field by field and colour variable by
colour variable (`footerLinks` is taken whole). A client with no profile gets the default; with no
default either, the pages look as they always did. An unknown, malformed or absent `client_id` is
treated as no client and gets the default, so branding never reveals which client ids exist.

The admin API's profile `GET` returns `own` (the profile's values), `effective` (after inheritance),
`sources` and `colorSources` (`client`, `default` or `tereo` per slot and variable) and `inherited`:
what applies without the profile's own layer (the default over stock for a client; `null`, meaning
stock, for the default profile). A preview needs `inherited` because `effective` cannot show what
lies under an overridden slot.

## Delivery to the browser

**Injection.** Core serves the UI's `index.html` itself. On a sign-in route it resolves the branding
for `?client_id=` and adds to `<head>` a `<style id="tereo-branding-style">` with the colours
(`:root:not([data-theme="dark"])` for light, so it never overrides the dark theme's values, and
`[data-theme="dark"]` for dark), preloads for the logo and background, a
`<link rel="icon">`, the app name as `<title>`, `data-brand-layout` on `<html>`, and
`<script type="application/json" id="tereo-branding">` with the effective values and
`scope: "auth"`. The first paint is already branded.

When branding resolves, a sign-in route always carries that block: with the literal `null` when
nothing applies (style, preloads and title untouched), so an unbranded sign-in renders stock at once.
The JSON is serialized with `<`, `>`, `&`, U+2028 and U+2029 escaped. If resolving fails, the error is
logged and the stock shell is served without the block, so the UI falls back to the fetch below;
branding never breaks sign-in. The sign-in routes go through the general rate limiter (per IP), since
each request can make core look up its `client_id`; the rest of the UI does not.

**Fallback.** `GET /oauth/branding?client_id=` (public) returns exactly what injection embeds, or
`null`. The UI calls it only when the page has no `#tereo-branding` block (the Vite dev server on
:4000, or a UI hosted apart from core); meanwhile it shows a neutral card, and after 1.5 s or on
error it renders stock. Asset URLs are root-relative (`/oauth/branding/assets/…`); the UI resolves
them against core's URL (`VITE_CORE_URL`, else its own origin), so they load wherever the UI is
served.

Resolved branding is cached in memory: per known client id (up to 1000), and the default profile in
a slot of its own. Every profile write and provisioning apply publishes an invalidation, so every
replica drops it; a replica also drops it when its Redis subscription reconnects, and every entry
expires after 5 minutes, so one that missed an invalidation catches up. Ids that match no client go
in a separate, bounded cache for 60 s and resolve to the default, so made-up ids cannot evict real
clients and each costs at most one client lookup.

## Assets

Images live in the core bucket `auth-service-branding` (private), keyed `<sha256>.<ext>`; the same
bytes uploaded twice, or provisioned on every start, are one object. Like every core bucket it is
read-only through the files API (`409 bucket_managed_by_core`), so only the branding routes and
provisioning write to it. The type comes from the bytes,
not the name or header, and must be allowed for the slot. An SVG is checked against an allowlist and
refused (`400 invalid_branding_image`) when it falls outside it: a fixed element set, no `<style>`,
`<script>` or `<foreignObject>`, no event attributes, `href` only to a local `#id`, `url()` only as
`url(#id)`, no `data:` or `javascript:`, no DOCTYPE or ENTITY, no processing instructions, UTF-8 only.
Nothing is rewritten, so the stored file is exactly what was uploaded. An upload over the slot's limit is `413 payload_too_large`.

`POST /v1/admin/branding/assets` (multipart: `slot`, then `file`) answers `{ sha256, ext, url }`; a
profile then references the image as `{ "sha256": "…" }`. A hash no live image has is `400
invalid_request` naming the slot. An image no profile references expires after **24 hours**
(`delete_after`, removed by the daily lifecycle sweep; a daily `branding-reconcile` job covers
profiles removed by deleting their client). Referencing an image clears the clock in the saving
transaction, and a dropped one starts it, which also keeps pages already rendered with a
just-replaced image working.

`GET /oauth/branding/assets/:file` serves them, public:
`Cache-Control: public, max-age=31536000, immutable` (the name is a content hash),
`X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin` (so a UI on another
origin can load them), the type from the extension, and for an SVG
`Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. A name that is not
`<64 hex>.<png|jpg|webp|svg|ico>`, or has no live image, is `404`.

## Who may edit

Permissions `branding.read`, `branding.write` and `branding.admin` are global (no organization holds
them); `admin` includes the other two.

| Target               | Read                                                             | Edit (`PUT`, `DELETE`, uploads)                                   |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| A client's profile   | `branding.read` and (owner, active grantee, or `branding.admin`) | `branding.write` and (owner, active grantee, or `branding.admin`) |
| `tereo-ui`'s profile | `branding.admin`                                                 | `branding.admin`                                                  |
| Default profile      | `branding.admin`                                                 | `branding.admin`                                                  |
| A client's grants    | `branding.read` (list) and (owner or `branding.admin`)           | `branding.write` (add, revoke) and (owner or `branding.admin`)    |

Uploading needs `branding.write` and the right to edit at least one profile (`branding.admin`, or
owner of or active grantee on a client other than the console client), else `403`; the image
belongs to nothing until a profile the caller may edit references it. A new image writes a
`CREATE object` audit entry. `GET /v1/admin/branding` lists the default (for `branding.admin`), the clients
with a profile the caller may read, and `brandable`: the clients with no profile yet that the caller
may start one on (owned or actively granted with `branding.write`; every one for `branding.admin`).
`tereo-ui` is listed only for `branding.admin`. A profile's `GET` says what the caller may do:
`canEdit`, `canManageGrants` (owner or `branding.admin`, holding `branding.write`) and
`canViewGrants` (owner or `branding.admin`: may list the grants).

A provisioned profile refuses `PUT` and `DELETE` with `409 managed_by_provisioning` and the
document's file name as `provisionedFrom`, for everyone, `branding.admin` included; so does
deleting its client (`DELETE /v1/admin/clients/:id`), which would leave the documents branding a
client that no longer exists. Writes are
last-write-wins. Each mutation writes an audit entry and emits `auth.branding.updated` (with the
slots changed) or `auth.branding.deleted`; a profile released from provisioning emits
`auth.branding.updated` with `changedSlots: []` and `released: true`. Grants emit `auth.branding.grant-added` and
`auth.branding.grant-revoked`. Reading the grant events needs `branding.admin`
(they name who may edit which client); `updated` and `deleted` need `branding.read`.

## Grants

A grant lets one user edit one client's branding, and nothing else about the client. It never
reaches the client's settings, the default profile or `tereo-ui`'s profile.

- `POST /v1/admin/branding/clients/:id/grants` with `{ userId }`; `GET` lists the active grants;
  `DELETE …/grants/:userId` revokes (recording who and when).
- Only the client's **owner** or a `branding.admin` manages them; a grantee cannot grant. The grantee
  still needs `branding.write` to use it.
- **`tereo-ui` takes no grants**, for anyone: `403`, `branding.admin` included. Its branding is
  `branding.admin`'s alone; give the person `branding.admin` instead.
- A deactivated user cannot be granted (`400 user_inactive`); an existing active grant is
  `409 conflict`. Deleting a client removes its grants and profile with it, and drops its cached
  branding, so a client later created under the same id starts unbranded.

## The console

`applyToConsole` brands the admin console too, with the colours and app name only (the block is
`scope: "console"`, no logos or layout). It is read from **`tereo-ui`'s profile, else the default
profile**: the toggle of a client's own profile has no effect. The editor shows the toggle only on
the profile that applies to `tereo-ui`, and on the default profile, while `tereo-ui` has its own,
says the toggle there does nothing. On every non-sign-in route core injects the console block
only when the toggle is on.

**Stock colours escape hatch.** While the Branding page is mounted, the UI disables
`#tereo-branding-style`, and enables it again on leaving. A palette that makes the console
unreadable can therefore always be fixed from the page that edits it. Skipping the injection
server-side would not cover in-app navigation.

## Provisioning

A document's `branding` block declares the default and per-client profiles; see
[provisioning.md](provisioning.md#branding) for the format, image paths and validation. A declared
profile is read-only through the API. Removing it from the documents **keeps its values**, clears
`provisioned` and leaves it editable: unlike other declared entries it is not retired.
