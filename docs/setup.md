# Set up and deploy

This guide describes the manual setup. It does not run commands against your Cloudflare account for you.

## Interactive setup

For a guided setup, install dependencies and run:

```sh
npm install
npm run setup
```

The wizard asks for the Discord application, public Worker URL, callback URL, role source, and cache backend. It can list accounts, zones, KV namespaces, D1 databases, and Access providers through the project-local `cf` CLI. For cached or bot-based roles, it can query a guild's role names and IDs using a bot token you enter. The token is never read from `config.json`.

The wizard asks for the Worker script name and checks whether that exact script exists in the selected account. If the named Access provider already exists, it shows its nonsecret settings and asks whether to update it or leave it as-is.

Before applying the setup, the wizard offers three Worker choices:

- Do not change the deployed Worker.
- Upload secrets only to the existing script. Wrangler immediately deploys a new version of that script's current code; it does not upload this repository's code.
- Deploy this repository's code to the selected script, replacing its currently deployed code, with the entered secrets included in the same deployment. If the script does not exist yet, this creates it.

The last option is a deployment and requires its own confirmation in the final review. A new install can create an OIDC signing key; its private JWK is saved under the ignored `.secrets` directory. Keep that file backed up securely and never commit it. Existing installations should keep their current signing key unless they are following the key rotation steps below.

The wizard does not apply D1 SQL migrations. After setup, run `npm run generate:types`, apply D1 migrations if you selected D1, and deploy code when you are ready if you skipped deployment in the wizard.

## What you need

- Node.js and npm
- A Cloudflare account with a domain you can use for the Worker
- A Discord application with an OAuth2 client ID and client secret
- A KV namespace for short-lived login state
- A D1 database if you choose D1 for role caching
- A Discord bot in the guilds you want to cache, with the Server Members intent enabled

You only need the bot when `ROLE_SOURCE` is `cache` or `bot`. The `user` role source uses the user's Discord authorization instead.

## Install the project

Clone the repository and install its dependencies:

```sh
git clone https://github.com/Aiko-IT-Systems/cloudflare-discord-oidc-worker.git
cd cloudflare-discord-oidc-worker
npm install
```

Wrangler commands go through the project wrapper. It merges the generic config with the selected install profile before running Wrangler. Use `npm run wrangler -- <command>` for commands that are not already exposed as an npm script.

## Choose your Wrangler profile

The project has three config files:

- `wrangler.jsonc` is the shared template. It has no account, domain, or resource IDs.
- `wrangler.user.jsonc` is the install-specific profile. It starts as `{}` and is tracked so each install can commit its own values.
- `wrangler.aitsys.jsonc` contains the AITSYS deployment values. The config generator selects it only when the Git `origin` is this repository and `wrangler.user.jsonc` is empty.

For a fork or another install, put your values in `wrangler.user.jsonc`. A non-empty user profile takes precedence over the AITSYS profile. Copy the relevant fields from the template and add your own account and resource IDs. Objects merge by key; arrays replace the template array, so include every binding you need in an overridden array.

If this is your own Worker, put your values in `wrangler.user.jsonc` before running Wrangler. An empty user profile in a clone whose `origin` points to the canonical repository selects the AITSYS profile.

The profile must set these variables under `vars`:

| Variable                    | Value                                                      |
|-----------------------------|------------------------------------------------------------|
| `CLIENT_ID`                 | Discord application's client ID                            |
| `ISSUER`                    | Public HTTPS origin of the Worker, with no trailing slash  |
| `REDIRECT_URIS`             | JSON array with the exact Cloudflare Access callback URL   |
| `ROLE_GUILD_IDS`            | JSON array of guild IDs whose claims the Worker may return |
| `ROLE_SOURCE`               | `cache`, `user`, or `bot`                                  |
| `CACHE_BACKEND`             | `kv` or `d1`, used with `ROLE_SOURCE=cache`                |
| `INCLUDE_EMAIL`             | `true` or `false`                                          |
| `FALLBACK_EMAIL`            | Email value used when Discord email is not included        |
| `OIDC_RETIRING_PUBLIC_KEYS` | JSON array; use `[]` unless rotating a signing key         |

The generic template declares both KV and D1 bindings. The selected profile needs valid resource bindings for the deployment you are configuring. The D1 database name used by this project is `discord-oidc`.

## Create Cloudflare resources

Create a KV namespace for login state:

```sh
npm run wrangler -- kv namespace create discord-oidc
```

Copy the returned namespace ID into the `KV` entry in the selected profile's `kv_namespaces` array.

If you use D1 role caching, create the database and apply the project's migrations:

```sh
npm run wrangler -- d1 create discord-oidc
npm run wrangler -- d1 migrations apply discord-oidc --remote
```

Copy the database ID from the create command into the `DB` entry in `d1_databases`. Keep `migrations_dir` set to `migrations`. Set `CACHE_BACKEND` to `d1`; for KV role caching, use `kv`.

Set `account_id` and add a custom-domain entry to `routes` in the selected profile. Set the route's `zone_id` to the ID of the zone that owns your Worker domain. Set `workers_dev` to `false` if the Worker should only use the custom domain. Keep `previews_enabled` set to `false` on the route and `preview_urls` set to `false` in the main config if you do not want preview URLs.

Run type generation after changing bindings:

```sh
npm run generate:types
```

Wrangler declaration files are local generated files and are ignored by Git.

## Add Worker secrets

Secrets are entered through Wrangler and do not belong in JSONC files:

```sh
npm run wrangler -- secret put DISCORD_CLIENT_SECRET
npm run wrangler -- secret put DISCORD_TOKEN
```

`DISCORD_CLIENT_SECRET` is required. `DISCORD_TOKEN` is needed for cached role refreshes or bot-based role lookup. Wrangler prompts for each value; do not put secret values in shell commands, config files, or issue reports.

Generate the OIDC signing key and store its private JWK as a Worker secret:

```sh
npm run generate:signing-key
Get-Content -Raw .secrets/oidc-signing-private-jwk.json | npm run wrangler -- secret put OIDC_SIGNING_PRIVATE_JWK
```

The command prints the public key and keeps the private key under ignored `.secrets/`. Do not commit or share that private file.

## Configure Discord and Cloudflare Access

The setup wizard asks which guild role claims to add to the Access provider. It can fetch role names for the guilds you enter, then lets you select all, none, or specific guild claims. A `roles:<guild-id>` claim contains every role ID the signed-in user has in that guild; it does not select individual roles by name. The selected guilds are also written to `ROLE_GUILD_IDS` so the Worker and Access provider stay aligned.

In the Discord application's OAuth2 settings, add the Cloudflare Access callback URL to the redirect list. It must exactly match the value in `REDIRECT_URIS`.

In Cloudflare Zero Trust, add a Generic OIDC identity provider:

- Client ID: the same Discord application ID used for `CLIENT_ID`
- Client secret: the Discord application secret
- Authorization URL: use the Worker's authorization endpoint from its discovery document; choose `/authorize/identify`, `/authorize/email`, `/authorize/guilds`, or `/authorize/roles` for the claims you need
- Token URL: the discovery document's `token_endpoint`
- Certificate URL: the discovery document's `jwks_uri`
- PKCE: enabled
- Scopes: `openid`, `email`, and `profile`
- Email claim name: leave blank; the Worker uses the standard `email` claim when enabled
- Add these custom claims if you need them: `id`, `username`, `global_name`, and `guilds`
- For each guild in `ROLE_GUILD_IDS`, add `roles:<guild-id>` (for example, `roles:123456789012345678`)

The discovery document is at `https://<your-worker-host>/.well-known/openid-configuration`. The host must match `ISSUER`. To request role claims, use the `/authorize/roles` endpoint and configure the matching guild IDs in `ROLE_GUILD_IDS`. Each `roles:<guild-id>` claim contains the user's role IDs for that guild; the Worker does not translate role IDs to role names.

Cloudflare's callback URL is commonly shown in the identity provider form. Use that exact URL in both the Cloudflare and Discord settings.

## Connect a fork to Cloudflare Workers Builds

Workers Builds can deploy changes pushed to a branch in your fork:

1. In Cloudflare, open **Workers & Pages**, select your Worker, then open **Settings → Build** and connect your GitHub account.
2. Select your fork and repository, then choose the production branch for this Worker. Every push to that branch can deploy to the selected Worker, so use a feature branch only when you intend to deploy it there.
3. Set the project root to `/`.
4. Set **Build command** to `npm run typecheck`. This generates profile-specific Wrangler types and checks the TypeScript. Wrangler bundles the Worker during deployment; there is no separate `npm run build` script.
5. Set **Deploy command** to `npm run deploy`. This generates the merged Wrangler config before deploying. Do not use `npx wrangler deploy` directly, because it skips profile selection.
6. Clear the **Preview command** and leave **Enable Preview builds** off. The preview URL setting in Wrangler does not disable Workers Builds preview deployments.
7. After connecting the repository, open **Settings → Build → Build cache** and select **Enable**. Cloudflare caches npm dependencies between builds; this is separate from the Worker’s KV or D1 role cache.

Before the first build, put your install-specific settings in `wrangler.user.jsonc` and add the runtime secrets to the Worker. Workers Builds does not read your local `.dev.vars` or `.secrets` files. Keep the Worker name and account, route, and binding IDs in the selected profile pointed at the resources you intend to update.

## Deploy

Check the merged config and generated types, then deploy:

```sh
npm run generate:wrangler-config
npm run typecheck
npm run deploy
```

The deploy script uses the generated profile config. Do not replace it with a direct `wrangler deploy` command in Cloudflare Workers Builds; set the build's deploy command to `npm run deploy` so profile generation runs first.

After deployment, open the discovery URL and confirm that its issuer and endpoints use your public Worker domain. Then use Cloudflare Access's provider test before making the provider available on your login page.

## Change signing keys later

When rotating the OIDC signing key:

1. Generate a new key and save its public JWK.
2. Add the current public JWK to `OIDC_RETIRING_PUBLIC_KEYS` and deploy that config.
3. Upload the new private JWK as `OIDC_SIGNING_PRIVATE_JWK`.
4. Keep the old public key published for at least the ID-token lifetime and JWKS cache period, then remove it and deploy again.

## Get help

Ask in the [AITSYS Discord server](https://discord.gg/RXA6u3jxdU). Do not post client secrets, bot tokens, private signing keys, or account credentials.
