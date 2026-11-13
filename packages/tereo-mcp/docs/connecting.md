# Connecting Claude and ChatGPT — @tereo-io/mcp

What an operator sets up so an MCP client can sign in through Tereo and call the app's tools.

Not yet verified: connecting Claude and ChatGPT to a deployment has not been tested end to end. The
steps below are the expected setup, built from what core and the MCP clients document. Treat the
first real connection as the acceptance test.

## The login client

Neither client registers itself with Tereo, so create one login client per connector ahead of time,
in a provisioning document of the deploy ([provisioning](../../tereo/docs/provisioning.md)). Each is
public (no secret), uses the authorization-code flow and names the service in `audience`:

```json
{
  "version": "1.0.0",
  "clients": [
    {
      "clientId": "claude-connector",
      "name": "Claude connector",
      "clientType": "public",
      "grantTypes": ["authorization_code", "refresh_token"],
      "redirectUris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback"
      ],
      "audience": ["query-service"],
      "consentRequired": true
    },
    {
      "clientId": "chatgpt-connector",
      "name": "ChatGPT connector",
      "clientType": "public",
      "grantTypes": ["authorization_code", "refresh_token"],
      "redirectUris": ["<the callback URL ChatGPT's connector form displays>"],
      "audience": ["query-service"],
      "consentRequired": true
    }
  ]
}
```

- `audience` is the service's slug, the `service` the app gives `createCoreClient`. Core reports a
  token active to the service only when its audience includes that slug.
- `consentRequired: true` shows the user a consent screen on first sign-in.
- Redirect URIs must match exactly. ChatGPT shows its callback URL in the connector form; copy it
  from there into `redirectUris`, and do not guess it. Claude's two URLs are above.
- To have `ctx.auth.name` and `ctx.auth.email` filled in, give each client the `scopes` `openid`, `profile` and `email`, and set the same list in the `scopes` option (see [Scopes](../README.md#scopes)).
- List the same `clientId`s in `allowedClients`. Tokens issued to any other client are refused.
- A token issued to a connector client is an ordinary Tereo access token for the service. Besides
  the MCP endpoint, the service's own routes behind the SDK's `requireAuth` accept it, with the
  user's permissions, unless the app restricts them with the SDK's `auth.allowedClients` option on
  `createCoreClient`.

## Deployment conditions

- Core and the MCP server are both reachable from the internet over https. The clients call both
  from their own servers, so `localhost` and private networks do not work.
- `publicUrl` is the MCP server's public origin, and the endpoint is `${publicUrl}${path}`.
- Core's `ISSUER` equals the URL its discovery document is served from. The MCP server fetches
  `${coreUrl}/.well-known/oauth-authorization-server` at start (`coreUrl`, else the URL the core
  client was created with, else `CORE_URL`) and tells clients to sign in at the issuer it names, so
  a mismatch sends clients to the wrong place.
- The permissions the tools name exist in the service's provisioning document and are granted to
  users through roles. A user sees only the tools whose permission they hold.

## Claude

1. In Claude, add a custom connector and enter the MCP endpoint URL, `${publicUrl}${path}`.
2. Under advanced settings, enter the client ID (`claude-connector`) and leave the client secret
   blank.
3. Connect. Claude finds Tereo from the `401` challenge, opens Tereo's sign-in and consent screens,
   then lists the tools the user's permissions allow.

## ChatGPT

1. In ChatGPT, add a custom connector (MCP) with the same endpoint URL, and choose OAuth.
2. Copy the callback URL the form displays into the `chatgpt-connector` client's `redirectUris`
   and deploy the provisioning document.
3. Enter the client ID (`chatgpt-connector`) and leave the client secret blank.
4. Connect and sign in through Tereo.

The exact labels of these forms change between releases; follow the client's own help where they
differ from the above.
