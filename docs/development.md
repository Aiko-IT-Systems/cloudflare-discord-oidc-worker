# Develop the Worker

## Install and run it locally

```sh
npm install
npm run start
```

`npm run start` generates the selected Wrangler config before starting the local Worker. The wrapper also handles the config for other Wrangler commands:

```sh
npm run wrangler -- <command> [...args]
```

For example:

```sh
npm run wrangler -- d1 migrations apply discord-oidc --local
```

Keep credentials in Wrangler secrets or ignored local variable files. Never add them to a Wrangler profile.

## Run checks

```sh
npm test
npm run typecheck
```

`npm run typecheck` first runs `npm run generate:types`. This refreshes `worker-configuration.d.ts` and `worker-bindings.d.ts` from the currently selected profile. Those files are ignored because binding types can contain install-specific values.

To regenerate only the Wrangler config, run:

```sh
npm run generate:wrangler-config
```

The merged config is written under ignored `.wrangler/`. The Wrangler wrapper runs the generator for you before each CLI command.

## Test a real Discord login locally

The project includes a loopback login harness. It starts Wrangler locally, opens a Discord login, exchanges the code with the local Worker, and verifies the returned ID token. It does not deploy.

1. Add `http://127.0.0.1:3000/callback` to the Discord application's redirect URI list, keeping any existing production callback.
2. Copy `.dev.vars.example` to `.dev.vars.local-login`.
3. Set `CLIENT_ID` and `DISCORD_CLIENT_SECRET` in `.dev.vars.local-login`. Leave the signing key blank on the first run; the script creates and saves a local key.
4. Set `TEST_MODE` to `identify`, `email`, `guilds`, or `roles`.
5. For role checks, set `TEST_GUILD_ID`, `TEST_ROLE_SOURCE`, and `TEST_BACKEND`. Add a bot token only when using `cache` or `bot`, invite that bot to the guild, and enable the Server Members intent.
6. Start the harness:

```sh
npm run test:local
```

The local harness reads `.dev.vars.local-login`, not `config.json`. It listens on loopback and stores test KV/D1 state under `.wrangler/local-login-state`. D1 mode applies project migrations to local storage before starting. Do not point local tests at production data when testing cache writes.

For cache mode, the harness supports a local scheduled event. Open the printed Local Explorer URL, run the configured cron from **Cron Triggers → Ad-Hoc Triggers**, then inspect **Observability → Events** or Wrangler logs for `role_snapshot_published` or `role_snapshot_refresh_failed`. The Worker fetches current Discord member data; the harness does not seed fake roles.

Stop with Ctrl+C. The script stops Wrangler and removes its temporary config while keeping your local vars file.

## Source layout

- `src/index.ts` exports the Worker entry point.
- `src/app.ts` defines the OIDC and OAuth routes.
- `src/config.ts` validates Worker variables and chooses Discord scopes.
- `src/client-auth.ts` handles OIDC client authentication.
- `src/discord.ts` contains Discord HTTP helpers.
- `src/protocol.ts` handles signing and OIDC metadata.
- `src/role-cache.ts` reads and refreshes role snapshots in KV or D1.
- `migrations/` contains D1 schema changes.
- `tests/` contains Vitest tests.
- `scripts/` contains the Wrangler wrapper, config/type generation, signing-key generation, and local login harness.

When changing a binding, update the selected Wrangler profile and regenerate types. When changing role-cache storage, keep KV and D1 behavior covered by tests. For Discord API requests, use the shared request helpers so timeouts, rate limits, and response validation stay consistent.

## Deploy a code change

Run the checks, then deploy with the profile-aware command:

```sh
npm test
npm run typecheck
npm run deploy
```

`npm run deploy` is the command to use in Cloudflare Workers Builds too. It generates the merged config before invoking Wrangler.

For questions, use the [AITSYS Discord server](https://discord.gg/RXA6u3jxdU). For bugs or feature requests, open one of the repository's issue forms. Never include secrets or private user data in a report.
