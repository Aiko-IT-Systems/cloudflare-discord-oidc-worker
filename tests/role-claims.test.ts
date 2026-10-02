import { afterEach, describe, expect, it, vi } from "vitest";
import * as jose from "jose";
import worker from "../src/index";

const CLIENT_ID = "123456789012345678";
const CLIENT_SECRET = "role-test-secret";
const ISSUER = "https://oidc.example.test";
const REDIRECT_URI =
	"https://team.cloudflareaccess.com/cdn-cgi/access/callback";
const GUILD_ID = "223456789012345678";
const USER_ID = "323456789012345678";
const fetchWorker = worker.fetch! as unknown as (
	request: Request,
	env: object,
	ctx: object,
) => Promise<Response>;

class MemoryKv {
	values = new Map<string, string>();
	async get<T>(key: string, type?: string): Promise<T | null> {
		const value = this.values.get(key);
		if (value === undefined) return null;
		return (type === "json" ? JSON.parse(value) : value) as T;
	}
	async put(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

class ReadD1Statement {
	values: unknown[] = [];
	constructor(
		private readonly sql: string,
		private readonly db: ReadD1,
	) {}
	bind(...values: unknown[]): this {
		this.values = values;
		this.db.lastBindings = values;
		return this;
	}
	async first<T>(): Promise<T | null> {
		this.db.lastQuery = this.sql;
		this.db.queries.push(this.sql);
		if (this.sql.includes("FROM active_role_snapshots"))
			return { snapshot_id: "active-snapshot", updated_at: Math.floor(Date.now() / 1000) } as T;
		if (this.sql.includes("FROM role_members"))
			return (this.db.rolesJson ? { roles_json: this.db.rolesJson } : null) as T | null;
		return null;
	}
}

class ReadD1 {
	rolesJson: string | null = null;
	lastQuery = "";
	lastBindings: unknown[] = [];
	queries: string[] = [];
	withSession(): this {
		return this;
	}
	prepare(sql: string): ReadD1Statement {
		return new ReadD1Statement(sql, this);
	}
}

async function makeKeys() {
	const pair = await jose.generateKeyPair("RS256", { extractable: true });
	const privateJwk = {
		...(await jose.exportJWK(pair.privateKey)),
		kid: "roles-test-key",
		alg: "RS256",
		use: "sig",
	};
	const publicJwk = await jose.exportJWK(pair.publicKey);
	return { privateJwk, publicJwk };
}

function makeEnv(options: {
	roleSource: "cache" | "user" | "bot";
	cacheBackend?: "kv" | "d1";
	roleGuildIds?: string[];
	kv: MemoryKv;
	db?: ReadD1;
	privateJwk: object;
}) {
	return {
		KV: options.kv,
		...(options.db ? { DB: options.db } : {}),
		CLIENT_ID,
		ISSUER,
		REDIRECT_URIS: JSON.stringify([REDIRECT_URI]),
		ROLE_GUILD_IDS: JSON.stringify(options.roleGuildIds ?? [GUILD_ID]),
		ROLE_SOURCE: options.roleSource,
		CACHE_BACKEND: options.cacheBackend ?? "kv",
		INCLUDE_EMAIL: "true",
		FALLBACK_EMAIL: "oauth@discord.com",
		OIDC_RETIRING_PUBLIC_KEYS: "[]",
		DISCORD_CLIENT_SECRET: CLIENT_SECRET,
		DISCORD_TOKEN: "test-bot-token",
		OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(options.privateJwk),
	};
}

async function challengeFor(verifier: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
	);
	return btoa(String.fromCharCode(...digest))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

async function exchangeToken(options: {
	roleSource: "cache" | "user" | "bot";
	cacheBackend?: "kv" | "d1";
	kv: MemoryKv;
	db?: ReadD1;
	privateJwk: object;
	responses: Response[];
}) {
	const verifier =
		"role-claims-code-verifier-long-enough-for-pkce-validation-123456";
	const challenge = await challengeFor(verifier);
	options.kv.values.set(
		`oidc:pending:${challenge}`,
		JSON.stringify({ nonce: "roles-test-nonce", mode: "roles" }),
	);
	const fetchMock = vi.fn();
	const responses = options.responses.slice(0, 3);
	if (options.roleSource === "user" || options.roleSource === "bot")
		responses.push(options.responses[3] ?? Response.json({ roles: [] }));
	responses.push(new Response(null, { status: 204 }));
	for (const response of responses) fetchMock.mockResolvedValueOnce(response);
	vi.stubGlobal("fetch", fetchMock);
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		client_secret: CLIENT_SECRET,
		code: "roles-test-code",
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	});
	const response = await fetchWorker(
		new Request(`${ISSUER}/token`, { method: "POST", body: form }),
		makeEnv(options),
		{},
	);
	const result = (await response.json()) as {
		id_token?: string;
		error?: string;
	};
	if (!response.ok || !result.id_token)
		throw new Error(
			`OIDC token request failed: ${response.status} ${result.error ?? ""}`,
		);
	const { publicJwk } = await makeKeysFromPrivateJwk(options.privateJwk);
	const verified = await jose.jwtVerify(
		result.id_token,
		await jose.importJWK(publicJwk, "RS256"),
		{ issuer: ISSUER, audience: CLIENT_ID },
	);
	return { claims: verified.payload, fetchMock };
}

async function makeKeysFromPrivateJwk(privateJwk: object) {
	const key = privateJwk as JsonWebKey & {
		kid?: string;
		alg?: string;
		use?: string;
	};
	const publicJwk = {
		kty: key.kty,
		n: key.n,
		e: key.e,
		kid: key.kid,
		alg: key.alg,
		use: key.use,
	};
	return { publicJwk };
}

function tokenResponses(scopes: string, roles = ["unused-role"]): Response[] {
	return [
		Response.json({
			access_token: "test-discord-token",
			token_type: "Bearer",
			expires_in: 3600,
			scope: scopes,
		}),
		Response.json({
			id: USER_ID,
			username: "test-user",
			email: "test@example.test",
			verified: true,
		}),
		Response.json([{ id: GUILD_ID }]),
		Response.json({ roles }),
	];
}

describe("role and guild configuration", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		{
			roleSource: "user" as const,
			expected: "identify email guilds guilds.members.read",
		},
		{ roleSource: "bot" as const, expected: "identify email guilds" },
		{ roleSource: "cache" as const, expected: "identify email guilds" },
	])(
		"requests scopes for the $roleSource role source",
		async ({ roleSource, expected }) => {
			const kv = new MemoryKv();
			const params = new URLSearchParams({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				response_type: "code",
				state: "scope-state",
				nonce: "scope-nonce",
				code_challenge: "C".repeat(43),
				code_challenge_method: "S256",
			});
			const response = await fetchWorker(
				new Request(`${ISSUER}/authorize/roles?${params}`),
				{
					...makeEnv({ roleSource, kv, privateJwk: {} }),
					OIDC_SIGNING_PRIVATE_JWK: undefined,
				},
				{},
			);
			const discordAuthorize = new URL(response.headers.get("Location")!);
			expect(response.status).toBe(302);
			expect(discordAuthorize.searchParams.get("scope")).toBe(expected);
		},
	);

	it("requests guild membership for guilds mode without requesting roles", async () => {
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			state: "guild-state",
			nonce: "guild-nonce",
			code_challenge: "D".repeat(43),
			code_challenge_method: "S256",
		});
		const response = await fetchWorker(
			new Request(`${ISSUER}/authorize/guilds?${params}`),
			{
				...makeEnv({ roleSource: "user", kv: new MemoryKv(), privateJwk: {} }),
				OIDC_SIGNING_PRIVATE_JWK: undefined,
			},
			{},
		);
		const discordAuthorize = new URL(response.headers.get("Location")!);
		expect(discordAuthorize.searchParams.get("scope")).toBe(
			"identify email guilds",
		);
	});

	it("adds guild and user-fetched roles claims when ROLE_SOURCE=user", async () => {
		const { privateJwk } = await makeKeys();
		const { claims, fetchMock } = await exchangeToken({
			roleSource: "user",
			kv: new MemoryKv(),
			privateJwk,
			responses: tokenResponses("identify email guilds guilds.members.read", [
				"member-role",
			]),
		});
		expect(claims.guilds).toEqual([GUILD_ID]);
		expect(claims[`roles:${GUILD_ID}`]).toEqual(["member-role"]);
		expect(fetchMock.mock.calls[3]![0]).toBe(
			`https://discord.com/api/v10/users/@me/guilds/${GUILD_ID}/member`,
		);
		expect(
			new Headers(fetchMock.mock.calls[3]![1]!.headers).get("Authorization"),
		).toBe("Bearer test-discord-token");
	});

	it("adds bot-fetched roles claims when ROLE_SOURCE=bot", async () => {
		const { privateJwk } = await makeKeys();
		const { claims, fetchMock } = await exchangeToken({
			roleSource: "bot",
			kv: new MemoryKv(),
			privateJwk,
			responses: tokenResponses("identify email guilds", ["bot-role"]),
		});
		expect(claims.guilds).toEqual([GUILD_ID]);
		expect(claims[`roles:${GUILD_ID}`]).toEqual(["bot-role"]);
		expect(fetchMock.mock.calls[3]![0]).toBe(
			`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${USER_ID}`,
		);
		expect(
			new Headers(fetchMock.mock.calls[3]![1]!.headers).get("Authorization"),
		).toBe("Bot test-bot-token");
	});

	it.each(["kv", "d1"] as const)(
		"reads fresh cached guild roles from the %s backend",
		async (cacheBackend) => {
			const { privateJwk } = await makeKeys();
			const kv = new MemoryKv();
			const db = new ReadD1();
			if (cacheBackend === "kv") {
				kv.values.set(
					`roles:${GUILD_ID}`,
					JSON.stringify({
						updatedAt: Math.floor(Date.now() / 1000),
						members: { [USER_ID]: ["cached-role"] },
					}),
				);
			} else {
				db.rolesJson = JSON.stringify(["cached-role"]);
			}
			const { claims, fetchMock } = await exchangeToken({
				roleSource: "cache",
				cacheBackend,
				kv,
				...(cacheBackend === "d1" ? { db } : {}),
				privateJwk,
				responses: tokenResponses("identify email guilds"),
			});
			expect(claims.guilds).toEqual([GUILD_ID]);
			expect(claims[`roles:${GUILD_ID}`]).toEqual(["cached-role"]);
			expect(fetchMock).toHaveBeenCalledTimes(4);
			if (cacheBackend === "d1") {
				expect(db.queries[0]).toContain("FROM active_role_snapshots");
				expect(db.queries[1]).toContain("FROM role_members");
				expect(db.lastBindings.slice(0, 2)).toEqual([GUILD_ID, USER_ID]);
			}
		},
	);

	it("does not include configured role claims for guilds the user does not belong to", async () => {
		const { privateJwk } = await makeKeys();
		const kv = new MemoryKv();
		kv.values.set(
			`roles:${GUILD_ID}`,
			JSON.stringify({
				updatedAt: Math.floor(Date.now() / 1000),
				members: { [USER_ID]: ["cached-role"] },
			}),
		);
		const { claims, fetchMock } = await exchangeToken({
			roleSource: "cache",
			kv,
			privateJwk,
			responses: [
				Response.json({
					access_token: "test-discord-token",
					token_type: "Bearer",
					expires_in: 3600,
					scope: "identify email guilds",
				}),
				Response.json({
					id: USER_ID,
					username: "test-user",
					email: "test@example.test",
					verified: true,
				}),
				Response.json([]),
			],
		});
		expect(claims.guilds).toEqual([]);
		expect(claims[`roles:${GUILD_ID}`]).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});
