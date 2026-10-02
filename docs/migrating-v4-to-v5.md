# Migrate from v4 to v5

Version 5 has breaking configuration and storage changes. It does not read the v4 `config.json` or automatically migrate the v4 signing key and role cache. Prepare and verify the v5 profile before switching production traffic.

## What changed

| v4                                                                                    | v5                                                                                           |
|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `config.json` fields such as `clientId`, `redirectUrls`, and `serversToCheckRolesFor` | Nonsecret settings in a Wrangler JSONC profile; secrets are Worker secrets                   |
| `clientSecret` in `config.json`                                                       | `DISCORD_CLIENT_SECRET` Worker secret                                                        |
| `DISCORD_TOKEN` optional Worker secret                                                | Still a Worker secret; required for cached refreshes and bot role lookup                     |
| Signing key generated and stored in the KV entry named `keys`                         | `OIDC_SIGNING_PRIVATE_JWK` Worker secret                                                     |
| `cacheRoles: true/false`                                                              | `ROLE_SOURCE=cache`, `user`, or `bot`; cached mode also chooses `CACHE_BACKEND=kv` or `d1`   |
| KV role maps stored under `roles:<guild-id>`                                          | Versioned KV snapshots or a D1 snapshot schema; v4 role-cache values are not reused          |
| `wrangler.toml` and `worker.ts`                                                       | `wrangler.jsonc` profiles and the `src/` Worker entry point                                  |
| OAuth code flow without required PKCE checks                                          | State, nonce, and S256 PKCE are required; enable PKCE in the Cloudflare Access OIDC provider |

The public OIDC endpoints remain `/authorize/<mode>`, `/token`, and `/jwks.json`. Keep the same custom Worker domain if you want the Access provider's endpoint URLs to stay the same.

## Update the Worker

1. Back up the v4 `config.json`, Wrangler settings, and KV namespace. Do not delete the old KV data until the v5 login and role claims are verified. Version 5 does not consume `config.json`; you can keep your ignored copy for reference, but do not copy secrets into the new Wrangler profile.
2. Install the v5 dependencies with `npm install`.
3. Put nonsecret settings in `wrangler.user.jsonc`: `account_id`, the custom-domain `routes` entry, `kv_namespaces`, and, if used, `d1_databases`. The tracked file starts as `{}`. Set the `KV` and optional `DB` bindings to your own resource IDs. Arrays replace the template's arrays, so include every binding and route you need.
4. Move the v4 config values into the v5 `vars`:

   | v4 setting                                 | v5 setting                                             |
   |--------------------------------------------|--------------------------------------------------------|
   | `clientId`                                 | `CLIENT_ID`                                            |
   | `redirectUrls`                             | `REDIRECT_URIS` as a JSON array string                 |
   | `includeEmail`                             | `INCLUDE_EMAIL` as `true` or `false`                   |
   | `fallbackEmail`                            | `FALLBACK_EMAIL`                                       |
   | `serversToCheckRolesFor`                   | `ROLE_GUILD_IDS` as a JSON array string                |
   | `cacheRoles: true`                         | `ROLE_SOURCE=cache`; choose `CACHE_BACKEND=kv` or `d1` |
   | `cacheRoles: false` with user-token lookup | `ROLE_SOURCE=user`                                     |
   | `cacheRoles: false` with bot-token lookup  | `ROLE_SOURCE=bot`                                      |

   Set `ISSUER` to the Worker's public HTTPS origin. Use the exact Cloudflare Access callback URL in `REDIRECT_URIS`.
5. Add runtime secrets to the v5 Worker. Do not put them in JSONC:

   ```sh
   npm run wrangler -- secret put DISCORD_CLIENT_SECRET
   npm run generate:signing-key
   Get-Content -Raw .secrets/oidc-signing-private-jwk.json | npm run wrangler -- secret put OIDC_SIGNING_PRIVATE_JWK
   ```

   If you use cached role refreshes or `ROLE_SOURCE=bot`, also set `DISCORD_TOKEN` with `npm run wrangler -- secret put DISCORD_TOKEN`. Keep the generated private JWK file private and out of Git.
6. Version 4 stored its signing key in the old KV value named `keys`; v5 will not read it. To rotate without invalidating existing v4 ID tokens, get the current public JWK from the v4 `/jwks.json` endpoint and add it to the v5 profile as a retiring public JWK. Version 4 published its key with `kid` `jwtRS256`, so the v5 value should have this shape:

   ```json
   [{
     "kty": "RSA",
     "kid": "jwtRS256",
     "n": "<v4 publicKey.n>",
     "e": "<v4 publicKey.e>",
     "alg": "RS256",
     "use": "sig"
   }]
   ```

   Set that JSON array as the `OIDC_RETIRING_PUBLIC_KEYS` variable. Keep it published until v4 ID tokens and cached signing keys have expired, then remove it. Never put the v4 private key in this variable. The manual steps are in [the signing-key rotation guide](setup.md#change-signing-keys-later).
7. If using D1, create or select a D1 database, set `CACHE_BACKEND=d1`, then apply the v5 schema:

   ```sh
   npm run wrangler -- d1 migrations apply discord-oidc --remote
   ```

   Keep the migration directory set to `migrations`. For KV role caching, set `CACHE_BACKEND=kv`; D1 is not needed for that mode.
8. Generate bindings, check the project, and deploy:

   ```sh
   npm run generate:types
   npm run typecheck
   npm run deploy
   ```

   `npm run typecheck` already regenerates types, so the first command is optional if you run typecheck. If you prefer to review before publishing, run `npm run deploy -- --dry-run` first.

## Update Cloudflare Access

Edit the existing Generic OIDC provider, or create a new one, using the v5 discovery document at `https://<worker-host>/.well-known/openid-configuration`:

- Authorization URL: the discovery endpoint for the mode you need, such as `/authorize/roles`
- Token URL: `/token`
- Certificate URL: `/jwks.json`
- PKCE: enabled
- Scopes: `openid`, `profile`, and `email` if `INCLUDE_EMAIL=true`
- Custom claims: add `id`, `username`, `global_name`, `guilds`, and each desired `roles:<guild-id>` claim
- Email claim name: leave blank for the standard `email` claim

The v5 Worker emits `id`, `username`, and `global_name` aliases and no longer emits the legacy `discriminator` claim. Each role claim is per guild and contains the signed-in user's role IDs in that guild. The matching guild IDs must be in `ROLE_GUILD_IDS`.

For `ROLE_SOURCE=cache`, v5 does not convert or trust v4 cache values. The next scheduled refresh rebuilds the configured guild snapshots; wait for a successful refresh before relying on role claims. D1 starts empty after its migration is applied.

For Git-connected deployment settings, use the separate [Workers Builds setup section](setup.md#connect-a-fork-to-cloudflare-workers-builds).
