# @tereo-io/react

Sign a React app in through [Tereo](https://github.com/tereo-io/tereo): OAuth with PKCE, a session
shared by tabs, API clients that renew their token, permission checks and live updates from core's
socket.

Peers: `react` ^19, `@tanstack/react-query` ^5, `axios` ^1, `socket.io-client` ^4.

```sh
npm install @tereo-io/react
```

ESM only. The peers must be installed by the app; the package does not depend on any UI library.

## Setup

Mount `TereoAuthProvider` inside a React Query `QueryClientProvider`.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TereoAuthProvider, type TereoUser } from "@tereo-io/react";

const queryClient = new QueryClient();

const config = {
  coreUrl: "https://core.example.com",
  clientId: "my-app",
  redirectUri: `${window.location.origin}/callback`,
  apis: { zeteo: "/api" }, // name -> base URL of each service the app calls with the user's token
  loadUser: async (apis) => {
    const { data } = await apis.zeteo.get<TereoUser>("/v1/me");
    return data; // must carry `permissions: string[]`
  },
};

export const App = () => (
  <QueryClientProvider client={queryClient}>
    <TereoAuthProvider config={config}>
      <Routes />
    </TereoAuthProvider>
  </QueryClientProvider>
);
```

The config is read once, at mount. Only `onEvent` follows later renders.

| Option | |
|--------|---|
| `coreUrl`, `clientId`, `redirectUri`, `apis`, `loadUser` | Required |
| `scopes` | Default `openid profile email offline_access` |
| `basePath` | Where the app is served, without a trailing slash. Default `""` |
| `isPublicPath(routePath)` | Routes that need no session. Added to the redirect path and `signedOutPath`, which are always public. Paths are route paths, without `basePath` |
| `signedOutPath` | Where a signed-out visitor lands. Public. Default `/` |
| `storagePrefix` | Default `tereo_${clientId}` |
| `tokenExpirationBuffer` | Milliseconds before expiry at which a token is renewed. Default 30000 |
| `requestTimeoutMs` | Default 15000 |
| `live`, `wsPath` | Open core's socket for live updates (default `true`), at `/ws` |
| `onEvent(event)` | Called for every event from core's socket, `session-revoked` included. Reads the latest `config.onEvent` |
| `debug` | Log internals to the console |

A visitor with no session on a path that is not public is sent to `${basePath}${signedOutPath}`.
If a silent session restore fails transiently (offline, a 5xx), the page stays signed out but is
not redirected until the next request or a reload.

## Hooks

```tsx
import { useApi, useAuth, usePublicApi } from "@tereo-io/react";

const Toolbar = () => {
  const { isLoading, isSignedIn, hasPermission, signIn } = useAuth();
  const zeteo = useApi("zeteo"); // an axios instance that sends and renews the token
  const open = usePublicApi("zeteo"); // the same API, no token

  if (isLoading) return null;
  if (!isSignedIn) return <button onClick={() => signIn()}>Sign in</button>;
  return hasPermission("zeteo.queries.run") ? <RunButton api={zeteo} /> : null;
};
```

`useAuth()` returns `user`, `isLoading`, `isSignedIn`, `isLive` (the socket is connected),
`hasPermission(required)`, `signIn`, `signOut`, `switchOrganization(orgId)` and `reloadUser()`.
`useAuth<MyUser>()` types `user`. `hasPermission` honours the hierarchy (`write` includes `read`,
`admin` includes all). `signIn`, `signOut` and `completeSignIn` are also exported as plain
functions.

## Callback page

`useCompleteSignIn().complete(search)` finishes sign-in on the redirect route. The exchange runs
once per mount, so React StrictMode's second effect is safe. `complete` rejects on failure; catch
it, or read `error`.

```tsx
import { useEffect } from "react";
import { useCompleteSignIn } from "@tereo-io/react";

export const Callback = () => {
  const { complete, error, isPending } = useCompleteSignIn();

  useEffect(() => {
    complete(new URLSearchParams(window.location.search))
      .then(({ returnTo }) => window.location.replace(returnTo ?? "/"))
      .catch(() => {}); // the failure is in `error`
  }, [complete]);

  if (error) return <p>Sign-in failed: {error.message}</p>;
  return isPending ? <p>Signing in...</p> : null;
};
```

## Requirements

- The app and core are on the same site.
- The app's origin is in core's `CORS_ALLOWED_ORIGINS`.
- The login client's redirect URI is the app's callback, on the app's origin.
- For live updates without giving the app a core scope, the login client needs `liveEvents`:
  the admin UI's "Live updates" toggle, `liveEvents` in the admin API, or `"liveEvents": true`
  in a provisioning document. Otherwise the token needs `core:events` or `core:account`.

## Fresh permissions from your own service

When core pushes a `permissions` event, the provider reloads the user through `loadUser`. The
SDK's `requireAuth` caches a token's introspection for up to 60 seconds, so the service's `me`
route drops the entry first, or it would answer with the permissions from before the change.

```ts
import express from "express";
import { createCoreClient } from "@tereo-io/sdk";

const core = createCoreClient({ /* ... */ });
await core.start();

const app = express();

app.get(
  "/v1/me",
  async (req, _res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (token) await core.auth.invalidateToken(token);
    next();
  },
  core.auth.requireAuth,
  (req, res) => {
    const auth = core.auth.validateUser(req);
    res.json({ id: auth.userId, name: auth.name, permissions: auth.permissions });
  }
);

app.use(core.auth.requireAuth); // everything else
```

## Core's API

A service UI's token is for the services in `apis`, not for core's API (`/v1/account`, ...), so
do not list core there. `switchOrganization` works anyway: it signs in again for the chosen
organization through core's authorize endpoint.
