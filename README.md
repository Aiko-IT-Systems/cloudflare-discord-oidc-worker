# Discord OIDC Worker for Cloudflare Access

This project lets you use Discord as an OpenID Connect provider for Cloudflare Access by wrapping Discord OAuth2 inside a Cloudflare Worker.

It was originally created by [Erisa](https://github.com/Erisa/discord-oidc-worker). This fork extends the idea with role support, cached role lookups, and a configurable email mode while keeping the original worker's goal intact. If this project helps you, please also consider supporting [Erisa](https://github.com/sponsors/Erisa).

## What It Does

The worker sits between Cloudflare Access and Discord:

1. Cloudflare Access sends the user to this worker's `/authorize/...` endpoint.
2. The worker redirects the user to Discord OAuth2 with the right scopes.
3. Discord sends the authorization code back to Cloudflare Access.
4. Cloudflare Access calls this worker's `/token` endpoint.
5. The worker exchanges the code, fetches Discord user data, optionally fetches guilds and roles, then signs an `id_token`.
6. Cloudflare Access uses that token and the published JWK set from `/jwks.json`.

Signing keys are generated once and stored in Workers KV.

## Features

- TypeScript-based Cloudflare Worker
- Hono routing
- Discord OAuth2 to OIDC bridge for Cloudflare Access
- Optional `guilds` claim
- Optional per-guild `roles:<guild_id>` claims
- Hourly cached role lookups through KV
- Toggleable email behavior for environments where real Discord email claims are not wanted

## Endpoints

- `/authorize/identify`
- `/authorize/email`
- `/authorize/guilds`
- `/authorize/roles`
- `/token`
- `/jwks.json`

The `/authorize/...` endpoints expect:

- `client_id`
- `redirect_uri`
- optional `state`

The `client_id` must match the configured Discord application id, and the `redirect_uri` must be present in `config.json`.

## Email Modes

This fork supports two email modes through `config.json`:

- `includeEmail: true`
  The worker requests Discord's `email` scope, requires a verified Discord account, and emits the real Discord email in the ID token.
- `includeEmail: false`
  The worker does not request the `email` scope, skips the verified-email requirement, and emits `fallbackEmail` instead.

This is useful because Cloudflare Access expects an email-like identity, but not every setup wants to depend on Discord email access.

## Claims

Depending on the chosen authorize route and config, the worker can emit:

- `email`
- `guilds`
- `roles:<guild_id>`
- most Discord user fields returned from `/users/@me`

## Configuration

Copy `config.sample.json` to `config.json` and fill it in.

Example:

```json
{
  "clientId": "00000000000000",
  "clientSecret": "AAAAAAAAAAAAAAAAAAA",
  "redirectUrls": [
    "https://YOURNAME.cloudflareaccess.com/cdn-cgi/access/callback"
  ],
  "includeEmail": true,
  "fallbackEmail": "oauth@discord.com",
  "serversToCheckRolesFor": [
    "123456789012345678"
  ],
  "cacheRoles": false
}
```

### Config Fields

- `clientId`
  Your Discord application client id.
- `clientSecret`
  Your Discord application client secret.
- `redirectUrls`
  Allowed redirect URLs. These must match what you configured in Discord and what Cloudflare Access will use.
- `includeEmail`
  Whether to request and expose the real Discord email claim.
- `fallbackEmail`
  Email claim used when `includeEmail` is `false`.
- `serversToCheckRolesFor`
  Guild ids that should be evaluated for role claims.
- `cacheRoles`
  Whether to use the scheduled KV-backed role cache.

## Setup

### 1. Requirements

- A Cloudflare account with Access / Zero Trust enabled
- A Discord application for OAuth2
- Node.js
- A Workers KV namespace

### 2. Install

```bash
npm install
```

### 3. Configure Wrangler

Set the KV namespace in `wrangler.toml`.

Example:

```toml
kv_namespaces = [
  { binding = "KV", id = "YOUR_KV_ID" }
]
```

If you want bot-based role lookups, add the bot token as a Worker secret:

```bash
npx wrangler secret put DISCORD_TOKEN
```

### 4. Configure Discord

Create a Discord application and add your Cloudflare Access callback URL as a redirect URI, for example:

```txt
https://YOURNAME.cloudflareaccess.com/cdn-cgi/access/callback
```

### 5. Configure Cloudflare Access

In Cloudflare Zero Trust:

1. Go to `Settings` -> `Authentication`
2. Add a new login method
3. Choose `OpenID Connect`
4. Fill in:

- `Auth URL`
  `https://YOUR_WORKER_HOST/authorize/email`
  or one of the other authorize modes
- `Token URL`
  `https://YOUR_WORKER_HOST/token`
- `Certificate URL`
  `https://YOUR_WORKER_HOST/jwks.json`
- `App ID`
  Your Discord client id
- `Client secret`
  Your Discord client secret
- `PKCE`
  Enabled

If you want guild or role claims in Access policies, add those custom claims in the provider configuration.

## Authorize Modes

### `/authorize/identify`

Requests only `identify`, plus `email` if `includeEmail` is enabled.

Use this for the smallest possible identity flow.

### `/authorize/email`

Alias for the normal email-capable flow.

If `includeEmail` is disabled, this behaves like `/authorize/identify`.

### `/authorize/guilds`

Adds the `guilds` scope so the worker can emit the `guilds` claim.

### `/authorize/roles`

Adds `guilds.members.read` so the worker can attempt role lookups through the user token when not using the cache path.

## Role Modes

### Cached roles

Recommended when possible.

- Set `cacheRoles` to `true`
- Configure `serversToCheckRolesFor`
- Add `DISCORD_TOKEN` as a Worker secret
- Invite the bot to every configured guild

The worker's scheduled handler refreshes role membership into KV every hour. During login, the token endpoint reads from KV instead of querying Discord live for each role lookup.

### Live role lookup with user token

Use `/authorize/roles` and set `cacheRoles` to `false`.

This uses Discord's `guilds.members.read` scope and can hit rate limits more easily.

### Live role lookup with bot token

Use `/authorize/guilds`, set `cacheRoles` to `false`, and configure `DISCORD_TOKEN`.

This fetches member roles through the bot for guilds the user belongs to.

## Local Development

Start the worker with:

```bash
npm run start
```

Example authorize URL:

```txt
http://127.0.0.1:8787/authorize/guilds?client_id=YOUR_CLIENT_ID&redirect_uri=https://YOURNAME.cloudflareaccess.com/cdn-cgi/access/callback&state=test
```

If you forget `client_id`, the worker will correctly return `Bad request.` like a tiny gatekeeping gremlin.

## Useful Scripts

```bash
npm run start
npm run typecheck
npm run cf-typegen
```

## Notes

- The worker currently reads `clientSecret` from `config.json` because that matches the existing project shape.
- `worker-configuration.d.ts` is generated by Wrangler via `npm run cf-typegen`.
- After changing `wrangler.toml`, rerun `npm run cf-typegen`.

## Credit

- Original project and core idea by [Erisa](https://github.com/Erisa/discord-oidc-worker)
- Additional inspiration from [kimcore/discord-oidc](https://github.com/kimcore/discord-oidc)
- Additional inspiration from [eidam/cf-access-workers-oidc](https://github.com/eidam/cf-access-workers-oidc)
