import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as jose from "jose";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const localConfigPath = resolve(root, "wrangler.local-login.jsonc");
const localVarsPath = resolve(root, ".dev.vars.local-login");
const workerOrigin = "http://127.0.0.1:8787";
const fakeAccessOrigin = "http://127.0.0.1:3000";
const callbackUri = `${fakeAccessOrigin}/callback`;
const issuer = "https://oidc.local.test";

if (!existsSync(localVarsPath)) {
	console.error(
		"Copy .dev.vars.example to .dev.vars.local-login, then fill in CLIENT_ID and DISCORD_CLIENT_SECRET.",
	);
	process.exit(1);
}

if (existsSync(localConfigPath)) {
	console.error(
		"wrangler.local-login.jsonc already exists. Move it aside before starting so this script never overwrites local config.",
	);
	process.exit(1);
}

function readDevVars(path) {
	const values = new Map();
	for (const line of readFileSync(path, "utf8")
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const equals = trimmed.indexOf("=");
		if (equals > 0)
			values.set(
				trimmed.slice(0, equals).trim(),
				trimmed.slice(equals + 1).trim(),
			);
	}
	return values;
}

function writeDevVar(path, name, value) {
	const lines = readFileSync(path, "utf8")
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/);
	const index = lines.findIndex((line) =>
		line.trimStart().startsWith(`${name}=`),
	);
	if (index >= 0) lines[index] = `${name}=${value}`;
	else lines.push(`${name}=${value}`);
	writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

const devVars = readDevVars(localVarsPath);
const clientId = devVars.get("CLIENT_ID") ?? "";
const clientSecret = devVars.get("DISCORD_CLIENT_SECRET") ?? "";
const testMode = devVars.get("TEST_MODE") ?? "identify";
const roleSource = devVars.get("TEST_ROLE_SOURCE") ?? "cache";
const cacheBackend = devVars.get("TEST_BACKEND") ?? "kv";
const testGuildId = devVars.get("TEST_GUILD_ID") ?? "";
const includeEmail = devVars.get("TEST_INCLUDE_EMAIL") ?? "true";
const fallbackEmail = devVars.get("TEST_FALLBACK_EMAIL") || "oauth@discord.com";
const hasBotToken = Boolean(devVars.get("DISCORD_TOKEN"));
if (!/^\d{17,20}$/.test(clientId)) {
	console.error(".dev.vars.local-login must contain a valid CLIENT_ID.");
	process.exit(1);
}
if (!clientSecret || clientSecret.includes("\n")) {
	console.error(
		".dev.vars.local-login must contain DISCORD_CLIENT_SECRET on one line.",
	);
	process.exit(1);
}
if (!["identify", "email", "guilds", "roles"].includes(testMode)) {
	console.error("TEST_MODE must be identify, email, guilds, or roles.");
	process.exit(1);
}
if (!["cache", "user", "bot"].includes(roleSource)) {
	console.error("TEST_ROLE_SOURCE must be cache, user, or bot.");
	process.exit(1);
}
if (!["kv", "d1"].includes(cacheBackend)) {
	console.error("TEST_BACKEND must be kv or d1.");
	process.exit(1);
}
if (testGuildId && !/^\d{17,20}$/.test(testGuildId)) {
	console.error("TEST_GUILD_ID must be a Discord guild ID or blank.");
	process.exit(1);
}
if (includeEmail !== "true" && includeEmail !== "false") {
	console.error("TEST_INCLUDE_EMAIL must be true or false.");
	process.exit(1);
}

let privateJwkText = devVars.get("OIDC_SIGNING_PRIVATE_JWK") ?? "";
if (!privateJwkText) {
	const { privateKey } = await jose.generateKeyPair("RS256", {
		modulusLength: 2048,
		extractable: true,
	});
	const privateJwk = {
		...(await jose.exportJWK(privateKey)),
		kid: `local-${randomUUID()}`,
		alg: "RS256",
		use: "sig",
	};
	privateJwkText = JSON.stringify(privateJwk);
	writeDevVar(localVarsPath, "OIDC_SIGNING_PRIVATE_JWK", privateJwkText);
}

try {
	const privateJwk = JSON.parse(privateJwkText);
	if (privateJwk.kty !== "RSA" || !privateJwk.d || !privateJwk.kid)
		throw new Error("invalid signing JWK");
} catch {
	console.error(
		"OIDC_SIGNING_PRIVATE_JWK must be a valid private RSA JWK. Leave it blank to let the script generate a local key.",
	);
	process.exit(1);
}

const vars = {
	ISSUER: issuer,
	REDIRECT_URIS: JSON.stringify([callbackUri]),
	ROLE_GUILD_IDS: JSON.stringify(testGuildId ? [testGuildId] : []),
	ROLE_SOURCE: roleSource,
	CACHE_BACKEND: cacheBackend,
	INCLUDE_EMAIL: includeEmail,
	FALLBACK_EMAIL: fallbackEmail,
	ALLOW_LOCAL_HTTP_REDIRECTS: "true",
};
const localPersistPath = resolve(root, ".wrangler/local-login-state");

writeFileSync(
	localConfigPath,
	`${JSON.stringify(
		{
			$schema: "./node_modules/wrangler/config-schema.json",
			name: "discord-oidc-local-login",
			main: "src/index.ts",
			compatibility_date: "2026-03-11",
			env: {
				"local-login": {
					name: "discord-oidc-local-login",
					kv_namespaces: [
						{ binding: "KV", id: "00000000000000000000000000000000" },
					],
					...(cacheBackend === "d1"
						? {
								d1_databases: [
									{
										binding: "DB",
										database_name: "discord-oidc-local-login",
										database_id: "00000000-0000-0000-0000-000000000000",
										migrations_dir: "migrations",
									},
								],
							}
						: {}),
					triggers: { crons: ["0 * * * *"] },
					vars,
				},
			},
		},
		null,
		2,
	)}\n`,
);
const wranglerCli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
if (cacheBackend === "d1") {
	console.log("Applying D1 migrations to the local Wrangler database...");
	const migration = spawnSync(
		process.execPath,
		[
			wranglerCli,
			"d1",
			"migrations",
			"apply",
			"discord-oidc-local-login",
			"--config",
			localConfigPath,
			"--env",
			"local-login",
			"--local",
			"--persist-to",
			localPersistPath,
		],
		{
			cwd: root,
			stdio: ["pipe", "inherit", "inherit"],
			input: "y\n",
			windowsHide: true,
		},
	);
	if (migration.error || migration.status !== 0) {
		if (existsSync(localConfigPath)) unlinkSync(localConfigPath);
		console.error(
			"Could not apply the local D1 migrations; no remote database was used.",
		);
		process.exit(1);
	}
}
const wrangler = spawn(
	process.execPath,
	[
		wranglerCli,
		"dev",
		"--config",
		localConfigPath,
		"--env",
		"local-login",
		"--local",
		"--ip",
		"127.0.0.1",
		"--port",
		"8787",
		"--persist-to",
		localPersistPath,
		"--test-scheduled",
	],
	{ cwd: root, stdio: "inherit", windowsHide: true },
);

let fakeAccess;
let stopped = false;
const sessions = new Map();

function htmlEscape(value) {
	return String(value).replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			],
	);
}

function sendHtml(response, status, content) {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(
		`<!doctype html><meta charset="utf-8"><title>Local Access test</title><main style="font:16px system-ui;max-width:44rem;margin:4rem auto">${content}</main>`,
	);
}

async function beginLogin(response) {
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	sessions.set(state, { verifier, nonce });
	const authorize = new URL(`${workerOrigin}/authorize/${testMode}`);
	authorize.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: callbackUri,
		response_type: "code",
		state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	response.writeHead(302, {
		location: authorize.toString(),
		"cache-control": "no-store",
	});
	response.end();
}

async function exchangeCode(url, response) {
	const state = url.searchParams.get("state") ?? "";
	const session = sessions.get(state);
	if (!session || url.searchParams.has("error")) {
		sendHtml(
			response,
			400,
			`<h1>Login did not complete</h1><p>${htmlEscape(url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "State mismatch")}</p>`,
		);
		return;
	}
	sessions.delete(state);
	const code = url.searchParams.get("code");
	if (!code) {
		sendHtml(
			response,
			400,
			"<h1>Discord did not return an authorization code.</h1>",
		);
		return;
	}
	try {
		const tokenResponse = await fetch(`${workerOrigin}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: callbackUri,
				code_verifier: session.verifier,
			}),
		});
		const tokens = await tokenResponse.json();
		if (!tokenResponse.ok || !tokens.id_token)
			throw new Error(
				tokens.error ??
					`Worker token endpoint returned ${tokenResponse.status}`,
			);

		const header = jose.decodeProtectedHeader(tokens.id_token);
		const jwksResponse = await fetch(`${workerOrigin}/jwks.json`);
		const jwks = await jwksResponse.json();
		const publicJwk = jwks.keys.find((key) => key.kid === header.kid);
		if (!publicJwk)
			throw new Error(
				"The Worker JWKS did not contain the ID token signing key.",
			);
		const verified = await jose.jwtVerify(
			tokens.id_token,
			await jose.importJWK(publicJwk, "RS256"),
			{
				issuer,
				audience: clientId,
			},
		);
		if (verified.payload.nonce !== session.nonce)
			throw new Error("The ID token nonce did not match the login request.");

		const claims = Object.fromEntries(
			Object.entries(verified.payload).filter(
				([key]) => key !== "iat" && key !== "exp",
			),
		);
		sendHtml(
			response,
			200,
			`<h1>Login complete</h1><p>Discord sign-in and token exchange finished. The PKCE verifier, ID-token signature, issuer, audience, and nonce checks passed.</p><pre>${htmlEscape(JSON.stringify(claims, null, 2))}</pre><p>You can close this tab and stop the local test with Ctrl+C.</p>`,
		);
	} catch (error) {
		sendHtml(
			response,
			502,
			`<h1>Login verification failed</h1><pre>${htmlEscape(error instanceof Error ? error.message : "Unknown error")}</pre>`,
		);
	}
}

fakeAccess = createServer((request, response) => {
	const url = new URL(request.url ?? "/", fakeAccessOrigin);
	if (request.method === "GET" && url.pathname === "/") {
		sendHtml(
			response,
			200,
			'<h1>Local OIDC test client</h1><p>Continue to Discord to sign in. After Discord returns to this loopback callback, this client calls the Worker token endpoint and checks its signed ID token.</p><p><a href="/login">Continue to Discord</a></p>',
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/login") {
		void beginLogin(response);
		return;
	}
	if (request.method === "GET" && url.pathname === "/callback") {
		void exchangeCode(url, response);
		return;
	}
	sendHtml(response, 404, "<h1>Not found</h1>");
});

async function waitForWorker() {
	for (let attempt = 0; attempt < 90; attempt++) {
		if (wrangler.exitCode !== null)
			throw new Error(`Wrangler exited with code ${wrangler.exitCode}`);
		try {
			const response = await fetch(
				`${workerOrigin}/.well-known/openid-configuration`,
			);
			if (response.ok) return;
		} catch {}
		await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
	}
	throw new Error("Wrangler did not become ready within 90 seconds.");
}

async function cleanup() {
	if (stopped) return;
	stopped = true;
	if (fakeAccess?.listening)
		await new Promise((resolveClose) => fakeAccess.close(() => resolveClose()));
	if (wrangler.exitCode === null) wrangler.kill("SIGTERM");
	if (existsSync(localConfigPath)) unlinkSync(localConfigPath);
}

process.once("exit", () => {
	try {
		if (existsSync(localConfigPath)) unlinkSync(localConfigPath);
	} catch {}
});

process.once("SIGINT", () => {
	void cleanup().then(() => process.exit(130));
});
process.once("SIGTERM", () => {
	void cleanup().then(() => process.exit(143));
});
wrangler.once("exit", (code) => {
	if (!stopped) {
		console.error(
			`Wrangler stopped with exit code ${code ?? "unknown"}; closing the local callback server.`,
		);
		void cleanup().then(() => {
			process.exitCode = code === 0 ? 0 : (code ?? 1);
		});
	}
});

try {
	await waitForWorker();
	await new Promise((resolveListen, rejectListen) => {
		fakeAccess.once("error", rejectListen);
		fakeAccess.listen(3000, "127.0.0.1", resolveListen);
	});
	console.log("\nLocal Worker and fake Access client are ready:");
	console.log(`  Open ${fakeAccessOrigin} and choose Continue to Discord.`);
	console.log(
		`  Register this additional Discord redirect URI: ${callbackUri}`,
	);
	console.log(
		"  The existing Cloudflare Access callback can remain registered.",
	);
	console.log(
		`  Mode: ${testMode}; role source: ${roleSource}; backend: ${cacheBackend}; guild configured: ${Boolean(testGuildId)}.`,
	);
	console.log(
		"  Open the Local Explorer: http://127.0.0.1:8787/cdn-cgi/local/explorer",
	);
	console.log(
		"  Run the configured cron from Explorer > Cron Triggers > Ad-Hoc Triggers, or visit http://127.0.0.1:8787/__scheduled?cron=0+*+*+*+*.",
	);
	console.log(
		"  Check Explorer > Observability > Events for role_snapshot_published and its backend/member count.",
	);
	if ((roleSource === "cache" || roleSource === "bot") && !hasBotToken) {
		console.log(
			"  Add DISCORD_TOKEN to .dev.vars.local-login for bot role lookups or cron cache refreshes.",
		);
	}
	if (!testGuildId && (testMode === "roles" || roleSource === "cache")) {
		console.log(
			"  Set TEST_GUILD_ID in .dev.vars.local-login to fetch role data for a guild.",
		);
	}
	if (roleSource === "user" && testMode !== "roles") {
		console.log(
			"  TEST_ROLE_SOURCE=user returns roles only with TEST_MODE=roles (guilds.members.read scope).",
		);
	} else if (roleSource !== "user" && !["guilds", "roles"].includes(testMode)) {
		console.log(
			"  Set TEST_MODE=guilds or roles to include guild membership and role claims in the login.",
		);
	}
	console.log(
		"  Finish the Discord consent in your browser; Ctrl+C stops the local test and removes its temporary Wrangler config. Your ignored .dev.vars.local-login file is preserved.\n",
	);
	await new Promise((resolveClose) => fakeAccess.once("close", resolveClose));
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Local login setup failed.",
	);
	await cleanup();
	process.exitCode = 1;
}
