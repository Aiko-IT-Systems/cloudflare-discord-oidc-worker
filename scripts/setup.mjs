import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = resolve(root, "wrangler.user.jsonc");
const cfEntrypoint = resolve(root, "node_modules/cf/bin/cf");
const baseUrl = (value) => value.replace(/\/+$/, "");
const colorsEnabled = stdout.isTTY && !("NO_COLOR" in process.env);
const ansi = { cyan: "\u001b[36m", green: "\u001b[32m", magenta: "\u001b[35m", yellow: "\u001b[33m", reset: "\u001b[0m", bold: "\u001b[1m" };
const paint = (value, color) => colorsEnabled ? `${ansi[color]}${value}${ansi.reset}` : value;
const prompt = (io, value) => io.question(paint(value, "cyan"));

export function parseJsonc(source) {
	let cleaned = "";
	let quoted = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = 0; i < source.length; i += 1) {
		const c = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (c === "\n") {
				lineComment = false;
				cleaned += c;
			}
			continue;
		}
		if (blockComment) {
			if (c === "*" && next === "/") {
				blockComment = false;
				i += 1;
			}
			continue;
		}
		if (quoted) {
			cleaned += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') quoted = false;
			continue;
		}
		if (c === '"') {
			quoted = true;
			cleaned += c;
		} else if (c === "/" && next === "/") {
			lineComment = true;
			i += 1;
		} else if (c === "/" && next === "*") {
			blockComment = true;
			i += 1;
		} else cleaned += c;
	}
	return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
}

export function mergeObjects(base, override) {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (
			value && typeof value === "object" && !Array.isArray(value) &&
			result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
		) result[key] = mergeObjects(result[key], value);
		else result[key] = value;
	}
	return result;
}

export function buildWorkerProfile({ base, accountId, zone, workerUrl, clientId, callbackUrl, guildIds, roleSource, backend, kvId, d1, includeEmail, fallbackEmail, workerName }) {
	const url = new URL(workerUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error("Worker URL must be a public HTTPS origin without credentials, query, or fragment.");
	if (url.pathname !== "/" || url.port || !(url.hostname === zone.name || url.hostname.endsWith(`.${zone.name}`)))
		throw new Error("Worker URL must be a hostname inside the selected Cloudflare zone, with no path or port.");
	if (!/^\d{17,20}$/.test(clientId)) throw new Error("Client ID must be a Discord application ID.");
	const redirect = new URL(callbackUrl);
	if (redirect.protocol !== "https:" || redirect.username || redirect.password)
		throw new Error("Cloudflare Access callback must be an HTTPS URL.");
	if (!Array.isArray(guildIds) || guildIds.some((id) => !/^\d{17,20}$/.test(id)))
		throw new Error("Guild IDs must be Discord snowflakes.");
	if (new Set(guildIds).size !== guildIds.length) throw new Error("Guild IDs must be unique.");
	const profile = mergeObjects(base, {
		...(workerName ? { name: workerName } : {}),
		account_id: accountId,
		workers_dev: false,
		preview_urls: false,
		kv_namespaces: [{ binding: "KV", id: kvId }],
		routes: [{ pattern: url.host, custom_domain: true, zone_id: zone.id, previews_enabled: false }],
		vars: {
			CLIENT_ID: clientId,
			ISSUER: baseUrl(url.origin),
			REDIRECT_URIS: JSON.stringify([callbackUrl]),
			ROLE_GUILD_IDS: JSON.stringify(guildIds),
			ROLE_SOURCE: roleSource,
			CACHE_BACKEND: backend,
			INCLUDE_EMAIL: String(includeEmail),
			FALLBACK_EMAIL: fallbackEmail,
		},
	});
	if (backend === "kv") profile.d1_databases = [];
	else profile.d1_databases = [{ binding: "DB", database_name: d1.name, database_id: d1.uuid, migrations_dir: "migrations" }];
	return profile;
}

export function redactSecrets(value) {
	if (Array.isArray(value)) return value.map(redactSecrets);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) =>
		[key, /secret|token|private.?key/i.test(key) ? "[redacted]" : redactSecrets(child)]));
}

function command(args, accountId) {
	const env = { ...process.env };
	if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
	const result = spawnSync(process.execPath, [cfEntrypoint, ...args], {
		cwd: root, env, encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`Cloudflare CLI command failed: ${args.slice(0, 3).filter((arg) => arg !== "--body").join(" ")} (exit ${result.status}).`);
	const output = (result.stdout ?? "").trim();
	if (!output) return null;
	try { return JSON.parse(output); } catch { throw new Error(`Could not parse output from cf ${args.slice(0, 3).join(" ")}.`); }
}

function items(value) {
	if (Array.isArray(value)) return value;
	if (Array.isArray(value?.result)) return value.result;
	if (Array.isArray(value?.data)) return value.data;
	return [];
}

function findExactWorker(scripts, workerName) {
	return scripts.find((script) =>
		(script?.script_name ?? script?.name ?? script?.id) === workerName,
	);
}

async function choose(io, label, values, describe) {
	if (!values.length) throw new Error(`No ${label} found. Create it in Cloudflare first, then run setup again.`);
	for (let i = 0; i < values.length; i += 1) io.write(`  ${i + 1}. ${describe(values[i])}\n`);
	while (true) {
		const selected = Number(await prompt(io, `Choose ${label} [1-${values.length}]: `));
		if (Number.isInteger(selected) && selected >= 1 && selected <= values.length) return values[selected - 1];
		io.write("Enter one of the listed numbers.\n");
	}
}

async function chooseMany(io, label, values, describe) {
	if (!values.length) return [];
	for (let i = 0; i < values.length; i += 1) io.write(`  ${i + 1}. ${describe(values[i])}\n`);
	io.write("Enter `all`, `none`, or a comma-separated list of numbers. Each claim returns every role ID the user has in that guild.\n");
	while (true) {
		const answer = (await prompt(io, `${label} [all]: `)).trim().toLowerCase();
		if (!answer || answer === "all") return [...values];
		if (answer === "none") return [];
		const selections = answer.split(",").map((value) => value.trim());
		const indexes = selections.map(Number);
		if (
			indexes.every((index) => Number.isInteger(index) && index >= 1 && index <= values.length) &&
			new Set(indexes).size === indexes.length
		) return indexes.map((index) => values[index - 1]);
		io.write(`Enter unique numbers from 1 to ${values.length}, all, or none.\n`);
	}
}

async function selectOrCreate(io, label, values, describe) {
	if (!values.length) {
		if (!await yesNo(io, `No ${label} found. Create one now?`)) throw new Error(`A ${label} is required to continue.`);
		return { create: true };
	}
	for (let i = 0; i < values.length; i += 1) io.write(`  ${i + 1}. ${describe(values[i])}\n`);
	io.write(`  ${values.length + 1}. Create a new ${label}\n`);
	while (true) {
		const selected = Number(await prompt(io, `Choose ${label} [1-${values.length + 1}]: `));
		if (Number.isInteger(selected) && selected >= 1 && selected <= values.length) return values[selected - 1];
		if (selected === values.length + 1) return { create: true };
		io.write("Enter one of the listed numbers.\n");
	}
}

async function yesNo(io, prompt, defaultValue = false) {
	const answer = (await io.question(paint(`${prompt} ${defaultValue ? "[Y/n]" : "[y/N]"} `, "cyan"))).trim().toLowerCase();
	return answer ? answer === "y" || answer === "yes" : defaultValue;
}

async function hidden(io, prompt) {
	io.write(paint(prompt, "cyan"));
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Secret entry needs an interactive terminal.");
	return new Promise((resolveSecret, reject) => {
		let value = "";
		io.pause();
		stdin.setRawMode(true);
		stdin.resume();
		const onData = (chunk) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\u0003") {
					stdin.off("data", onData); stdin.setRawMode(false); io.resume(); stdout.write("\n"); reject(new Error("Cancelled.")); return;
				}
				if (char === "\r" || char === "\n") {
					stdin.off("data", onData); stdin.setRawMode(false); io.resume(); stdout.write("\n"); resolveSecret(value); return;
				}
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else if (char >= " ") value += char;
			}
		};
		stdin.on("data", onData);
	});
}

export async function fetchGuildRoles(guildId, botToken, fetchImpl = fetch) {
	if (!/^\d{17,20}$/.test(guildId)) throw new Error("Guild ID must be a Discord snowflake.");
	const response = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
		headers: {
			Authorization: `Bot ${botToken}`,
			"User-Agent": `DiscordBot (https://github.com/Aiko-IT-Systems/cloudflare-discord-oidc-worker, ${JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version})`,
		},
	});
	if (!response.ok) throw new Error(`Discord role lookup failed with HTTP ${response.status}. Check the bot's guild access and token.`);
	const roles = await response.json();
	if (!Array.isArray(roles)) throw new Error("Discord returned an unexpected role list.");
	return roles.filter((role) => role && typeof role.id === "string" && typeof role.name === "string");
}

function createSigningJwk() {
	const kid = randomUUID();
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
	return {
		privateJwk: { ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid },
		publicJwk: { ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid },
	};
}

async function main() {
	if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run `npm run setup` in an interactive terminal.");
	const io = createInterface({ input: stdin, output: stdout });
	try {
		io.write(`${paint("🐾 Discord OIDC Worker setup 🐈", "magenta")}\nThis wizard can create Cloudflare resources and update an Access provider. Nothing is changed until the final review.\n\n`);
		const accounts = items(command(["accounts", "list", "--per-page", "100"]));
		const account = await choose(io, "Cloudflare account", accounts, (x) => `${x.name} (${x.id})`);
		const accountId = account.id;
		const base = parseJsonc(readFileSync(profilePath, "utf8"));
		const workerName = (await prompt(io, `Worker script name [${base.name ?? "discord-oidc"}]: `)).trim() || base.name || "discord-oidc";
		if (!/^[a-zA-Z0-9_-]+$/.test(workerName)) throw new Error("Worker script name may only contain letters, numbers, hyphens, and underscores.");
		const matches = items(command(["workers", "scripts", "search", "--name", workerName, "--per-page", "100"], accountId));
		const existingWorker = findExactWorker(matches, workerName);
		if (existingWorker) io.write(`Found existing Worker script: ${workerName}.\n`);
		else io.write(`No existing Worker script named ${workerName} was found. A code deployment can create it; secret-only upload is unavailable.\n`);
		const zones = items(command(["zones", "list", "--account-id", accountId, "--per-page", "100"], accountId));
		const zone = await choose(io, "domain zone", zones, (x) => `${x.name} (${x.status})`);
		const workerUrl = baseUrl((await prompt(io, "Public Worker URL (for example https://auth.example.com): ")).trim());
		const clientId = (await prompt(io, "Discord application client ID: ")).trim();
		const callbackUrl = (await prompt(io, "Cloudflare Access callback URL: ")).trim();
		const includeEmail = await yesNo(io, "Include Discord email in the ID token?", true);
		const fallbackEmail = (await prompt(io, "Fallback email when Discord provides none [oauth@discord.com]: ")).trim() || "oauth@discord.com";
		const clientSecret = await hidden(io, "Discord client secret (hidden): ");
		const signingKeyPath = resolve(root, ".secrets/oidc-signing-private-jwk.json");
		const freshWorker = await yesNo(io, "Is this a new Worker with no OIDC signing key yet?", !existsSync(signingKeyPath));
		const signingKeys = freshWorker
			? existsSync(signingKeyPath)
				? { privateJwk: parseJsonc(readFileSync(signingKeyPath, "utf8")) }
				: createSigningJwk()
			: undefined;
		const roleSource = await choose(io, "role source", ["cache", "user", "bot"], (x) => x);
		const backend = roleSource === "cache" ? await choose(io, "role cache backend", ["kv", "d1"], (x) => x) : "kv";
		let guildIds = [];
		let botToken;
		if (roleSource !== "user") {
			botToken = await hidden(io, "Discord bot token for role discovery and Worker refreshes (hidden): ");
		}
		const guildList = (await prompt(io, "Guild IDs to check for role claims, comma separated: ")).split(",").map((x) => x.trim()).filter(Boolean);
		if (botToken && guildList.length) {
			for (const guildId of guildList) {
				const roles = await fetchGuildRoles(guildId, botToken);
				io.write(`\nRoles in ${guildId}:\n`);
				for (const role of roles) io.write(`  ${role.name} (${role.id})\n`);
			}
		}
		guildIds = await chooseMany(io, "Guild role claims to add to Access", guildList, (id) => `roles:${id}`);
		const namespaces = items(command(["kv", "namespaces", "list", "--per-page", "100"], accountId));
		let kv = namespaces.find((x) => x.title === "discord-oidc");
		if (!kv) kv = await selectOrCreate(io, "KV namespace for login state", namespaces, (x) => `${x.title} (${x.id})`);
		const renameKv = !kv.create && kv.title !== "discord-oidc" && await yesNo(io, `Rename ${kv.title} to discord-oidc? This keeps its ID and stored values.`);
		let d1;
		if (backend === "d1") {
			const databases = items(command(["d1", "list", "--per-page", "100"], accountId));
			d1 = await selectOrCreate(io, "D1 database", databases, (x) => `${x.name} (${x.uuid})`);
		}
		const providers = items(command(["zero-trust", "identity-providers", "list", "--per-page", "100"], accountId));
		const providerName = (await prompt(io, "Cloudflare Access provider name: ")).trim();
		if (!providerName) throw new Error("Access provider name is required.");
		const existing = providers.find((x) => x.name === providerName);
		let providerAction = "create";
		if (existing) {
			const current = command(["zero-trust", "identity-providers", "get", existing.id], accountId);
			io.write(`\n${paint("🐈 Existing provider settings", "yellow")}:\n${JSON.stringify(redactSecrets(current), null, 2)}\n`);
			providerAction = await yesNo(io, "Update this provider? (No keeps it unchanged and continues with the Worker profile)") ? "update" : "skip";
		}
		buildWorkerProfile({ base, accountId, zone, workerUrl, clientId, callbackUrl, guildIds, roleSource, backend, kvId: kv.id ?? "created-after-review", d1: d1?.create ? { name: "discord-oidc", uuid: "created-after-review" } : d1, includeEmail, fallbackEmail, workerName });
		const providerBody = {
			name: providerName,
			type: "oidc",
			config: {
				client_id: clientId,
				client_secret: clientSecret,
				auth_url: `${baseUrl(workerUrl)}/authorize/roles`,
				token_url: `${baseUrl(workerUrl)}/token`,
				certs_url: `${baseUrl(workerUrl)}/jwks.json`,
				pkce_enabled: true,
				claims: ["id", "username", "global_name", "guilds", ...guildIds.map((id) => `roles:${id}`)],
				scopes: ["openid", ...(includeEmail ? ["email"] : []), "profile"],
			},
		};
		io.write("\nFinal review\n");
		io.write(`Account: ${account.name}\nDomain: ${zone.name}\nWorker script: ${workerName} (${existingWorker ? "exists" : "will be created if code is deployed"})\nWorker URL: ${workerUrl}\nKV: ${kv.create ? "create discord-oidc" : kv.title}\nRole source/cache: ${roleSource}/${backend}\nProvider action: ${providerAction}\n`);
		if (renameKv) io.write("KV namespace: rename to discord-oidc (ID and values stay unchanged)\n");
		if (d1?.create) io.write("D1 database: create discord-oidc\n");
		if (kv.create) io.write("KV namespace: create discord-oidc\n");
		if (providerAction !== "skip") io.write("Access provider credentials will be updated with the Discord client secret.\n");
		io.write(`Access role claims: ${guildIds.length ? guildIds.map((id) => `roles:${id}`).join(", ") : "none"}\n`);
		const deployCode = await yesNo(io, `Deploy this repository's code to ${workerName} now? This replaces the currently deployed script${existingWorker ? "" : " or creates it"}.`, false);
		const uploadSecretsOnly = !deployCode && Boolean(existingWorker) && await yesNo(io, `Upload secrets only to ${workerName}? Wrangler immediately deploys a new version of its current code; this does not upload this repository's code.`, false);
		io.write(`Worker action: ${deployCode ? `deploy this repository's code to ${workerName}${existingWorker ? " (replaces current code)" : " (creates the script)"}` : uploadSecretsOnly ? `upload secrets only to existing script ${workerName}; current code stays deployed` : "no Worker deployment or secret upload"}\n`);
		io.write("Local profile will be written to wrangler.user.jsonc.\n");
		if (!await yesNo(io, "Apply this setup?")) return;
		if (kv.create) kv = command(["kv", "namespaces", "create", "--title", "discord-oidc"], accountId);
		if (!kv?.id) throw new Error("Cloudflare did not return a KV namespace ID.");
		if (renameKv) kv = command(["kv", "namespaces", "update", kv.id, "--title", "discord-oidc"], accountId);
		if (!kv?.id) throw new Error("Cloudflare did not return the renamed KV namespace.");
		if (d1?.create) d1 = command(["d1", "create", "--name", "discord-oidc"], accountId);
		if (backend === "d1" && !d1?.uuid) throw new Error("Cloudflare did not return a D1 database ID.");
		const finalProfile = buildWorkerProfile({ base, accountId, zone, workerUrl, clientId, callbackUrl, guildIds, roleSource, backend, kvId: kv.id, d1, includeEmail, fallbackEmail, workerName });
		writeFileSync(profilePath, `${JSON.stringify(finalProfile, null, "\t")}\n`);
		io.write("Saved wrangler.user.jsonc.\n");
		if (providerAction !== "skip") {
			const bodyDirectory = mkdtempSync(join(tmpdir(), "discord-oidc-setup-"));
			const bodyPath = join(bodyDirectory, "provider-body.json");
			writeFileSync(bodyPath, JSON.stringify(providerBody), { mode: 0o600, flag: "wx" });
			try {
				const args = ["zero-trust", "identity-providers", ...(providerAction === "update" ? ["update", existing.id] : ["create"]), "--body", `@${bodyPath}`];
				command(args, accountId);
			} finally {
				rmSync(bodyDirectory, { recursive: true, force: true });
			}
		}
		if (deployCode || uploadSecretsOnly) {
			const generated = spawnSync(process.execPath, [resolve(root, "scripts/generate-worker-config.mjs")], { cwd: root, encoding: "utf8", windowsHide: true, stdio: "inherit" });
			if (generated.error) throw generated.error;
			if (generated.status !== 0) throw new Error("Could not generate the effective Wrangler config.");
			const secretValues = { DISCORD_CLIENT_SECRET: clientSecret };
			if (botToken) secretValues.DISCORD_TOKEN = botToken;
			if (signingKeys) secretValues.OIDC_SIGNING_PRIVATE_JWK = JSON.stringify(signingKeys.privateJwk);
			if (signingKeys && !existsSync(signingKeyPath)) {
				const secretsDirectory = resolve(root, ".secrets");
				mkdirSync(secretsDirectory, { recursive: true });
				writeFileSync(signingKeyPath, `${JSON.stringify(signingKeys.privateJwk)}\n`, { mode: 0o600, flag: "wx" });
			}
			if (deployCode) {
				const secretsDirectory = mkdtempSync(join(tmpdir(), "discord-oidc-secrets-"));
				const secretsPath = join(secretsDirectory, "secrets.json");
				writeFileSync(secretsPath, JSON.stringify(secretValues), { mode: 0o600, flag: "wx" });
				try {
					const child = spawnSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--name", workerName, "--config", resolve(root, "wrangler.generated.jsonc"), "--secrets-file", secretsPath], { cwd: root, encoding: "utf8", windowsHide: true, stdio: "inherit" });
					if (child.error) throw child.error;
					if (child.status !== 0) throw new Error("Wrangler could not deploy this repository's Worker code.");
				} finally {
					rmSync(secretsDirectory, { recursive: true, force: true });
				}
			} else {
				const child = spawnSync(process.execPath, [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "secret", "bulk", "--name", workerName, "--config", resolve(root, "wrangler.generated.jsonc")], { cwd: root, input: `${JSON.stringify(secretValues)}\n`, encoding: "utf8", windowsHide: true, stdio: ["pipe", "inherit", "inherit"] });
				if (child.error) throw child.error;
				if (child.status !== 0) throw new Error("Wrangler could not upload the selected Worker secrets.");
			}
		}
		io.write(`${paint("Setup complete 🐾", "green")} Generate declarations with ${paint("npm run generate:types", "bold")} before building.\n`);
	} finally { io.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Setup stopped: ${error instanceof Error ? error.message : "unknown error"}`);
		process.exitCode = 1;
	});
}
