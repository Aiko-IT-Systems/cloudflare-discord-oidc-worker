import { afterEach, describe, expect, it, vi } from "vitest";
import * as jose from "jose";
import worker from "../src/index";

const CLIENT_ID = "123456789012345678";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI =
	"https://team.cloudflareaccess.com/cdn-cgi/access/callback";
const ISSUER = "https://oidc.example.test";
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

async function makeKeys(): Promise<{
	privateJwk: JsonWebKey & { kid: string; alg: string; use: string };
	publicJwk: JsonWebKey;
}> {
	const pair = await jose.generateKeyPair("RS256", { extractable: true });
	const privateJwk = {
		...(await jose.exportJWK(pair.privateKey)),
		kid: "key-active",
		alg: "RS256",
		use: "sig",
	};
	const publicJwk = await jose.exportJWK(pair.publicKey);
	return { privateJwk, publicJwk };
}

function makeEnv(kv = new MemoryKv(), privateJwk?: object) {
	return {
		KV: kv,
		CLIENT_ID,
		ISSUER,
		REDIRECT_URIS: JSON.stringify([REDIRECT_URI]),
		ROLE_GUILD_IDS: "[]",
		ROLE_SOURCE: "cache",
		CACHE_BACKEND: "kv",
		INCLUDE_EMAIL: "true",
		FALLBACK_EMAIL: "oauth@discord.com",
		OIDC_RETIRING_PUBLIC_KEYS: "[]",
		DISCORD_CLIENT_SECRET: CLIENT_SECRET,
		...(privateJwk
			? { OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk) }
			: {}),
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

describe("OIDC endpoints", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("publishes OIDC discovery metadata from the configured issuer", async () => {
		const response = await fetchWorker(
			new Request(`${ISSUER}/.well-known/openid-configuration`),
			makeEnv(),
			{},
		);
		const metadata = (await response.json()) as Record<string, unknown>;
		expect(response.status).toBe(200);
		expect(metadata.issuer).toBe(ISSUER);
		expect(metadata.authorization_endpoint).toBe(
			`${ISSUER}/authorize/identify`,
		);
		expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
	});

	it("forwards state, nonce, and S256 PKCE to Discord after validating redirect URI", async () => {
		const kv = new MemoryKv();
		const challenge = "A".repeat(43);
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			state: "access-state",
			nonce: "access-nonce",
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		const response = await fetchWorker(
			new Request(`${ISSUER}/authorize/identify?${params}`),
			makeEnv(kv),
			{},
		);
		const redirect = new URL(response.headers.get("Location")!);
		expect(response.status).toBe(302);
		expect(redirect.searchParams.get("state")).toBe("access-state");
		expect(redirect.searchParams.get("nonce")).toBe("access-nonce");
		expect(redirect.searchParams.get("code_challenge")).toBe(challenge);
		expect(kv.values.get(`oidc:pending:${challenge}`)).toContain(
			"access-nonce",
		);
	});

	it("rejects an unregistered redirect URI", async () => {
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: "https://attacker.test/callback",
			response_type: "code",
		});
		const response = await fetchWorker(
			new Request(`${ISSUER}/authorize/identify?${params}`),
			makeEnv(),
			{},
		);
		expect(response.status).toBe(400);
	});

	it("allows HTTP redirects only for explicitly enabled loopback local tests", async () => {
		const callback = "http://127.0.0.1:3000/callback";
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: callback,
			response_type: "code",
			state: "local-state",
			nonce: "local-nonce",
			code_challenge: "B".repeat(43),
			code_challenge_method: "S256",
		});
		const localResponse = await fetchWorker(
			new Request(`${ISSUER}/authorize/identify?${params}`),
			{
				...makeEnv(),
				REDIRECT_URIS: JSON.stringify([callback]),
				ALLOW_LOCAL_HTTP_REDIRECTS: "true",
			},
			{},
		);
		const remoteResponse = await fetchWorker(
			new Request(`${ISSUER}/authorize/identify?${params}`),
			{ ...makeEnv(), REDIRECT_URIS: JSON.stringify([callback]) },
			{},
		);
		expect(localResponse.status).toBe(302);
		expect(remoteResponse.status).toBe(500);
	});

	it("validates PKCE client binding and returns a signed OIDC token with stable claims", async () => {
		const kv = new MemoryKv();
		const { privateJwk, publicJwk } = await makeKeys();
		const verifier =
			"verifier-value-that-is-long-enough-to-pass-pkce-validation-123456";
		const challenge = await challengeFor(verifier);
		kv.values.set(
			`oidc:pending:${challenge}`,
			JSON.stringify({ nonce: "expected-nonce", mode: "identify" }),
		);
		const upstream = vi.fn();
		upstream.mockResolvedValueOnce(
			Response.json({
				access_token: "discord-secret-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "identify email",
			}),
		);
		upstream.mockResolvedValueOnce(
			Response.json({
				id: "987654321012345678",
				username: "lala",
				global_name: "Lala",
				email: "lala@example.test",
				verified: true,
			}),
		);
		upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", upstream);
		const body = new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code: "one-time-code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			grant_type: "authorization_code",
		});
		const response = await fetchWorker(
			new Request(`${ISSUER}/token`, { method: "POST", body }),
			makeEnv(kv, privateJwk),
			{},
		);
		const tokenExchangeBody = new URLSearchParams(
			upstream.mock.calls[0]![1]!.body as string,
		);
		const tokens = (await response.json()) as {
			id_token: string;
			access_token: string;
			expires_in: number;
		};
		const verified = await jose.jwtVerify(
			tokens.id_token,
			await jose.importJWK(publicJwk, "RS256"),
			{ issuer: ISSUER, audience: CLIENT_ID },
		);
		expect(response.status).toBe(200);
		expect(verified.payload.sub).toBe("987654321012345678");
		expect(verified.payload.nonce).toBe("expected-nonce");
		expect(verified.protectedHeader.kid).toBe("key-active");
		expect(tokens.access_token).not.toBe("discord-secret-token");
		expect(tokens.expires_in).toBe(300);
		expect(tokenExchangeBody.get("code_verifier")).toBe(verifier);
		expect(upstream.mock.calls[2]![0]).toBe(
			"https://discord.com/api/v10/oauth2/token/revoke",
		);
		expect(
			new URLSearchParams(upstream.mock.calls[2]![1]!.body as string).get(
				"token",
			),
		).toBe("discord-secret-token");
		expect(kv.values.has(`oidc:pending:${challenge}`)).toBe(false);
	});

	it("completes a fake Cloudflare Access login from authorize through the PKCE token exchange", async () => {
		const kv = new MemoryKv();
		const { privateJwk, publicJwk } = await makeKeys();
		const verifier =
			"fake-access-login-verifier-with-at-least-43-characters-123456789";
		const challenge = await challengeFor(verifier);
		const env = makeEnv(kv, privateJwk);
		const accessState = "fake-access-state";
		const accessNonce = "fake-access-nonce";
		const authorization = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			state: accessState,
			nonce: accessNonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});

		// Cloudflare Access starts the login at the Worker's authorization endpoint.
		const authorizationResponse = await fetchWorker(
			new Request(`${ISSUER}/authorize/identify?${authorization}`),
			env,
			{},
		);
		const discordAuthorization = new URL(
			authorizationResponse.headers.get("Location")!,
		);
		expect(authorizationResponse.status).toBe(302);
		expect(discordAuthorization.searchParams.get("state")).toBe(accessState);
		expect(discordAuthorization.searchParams.get("nonce")).toBe(accessNonce);
		expect(discordAuthorization.searchParams.get("code_challenge")).toBe(
			challenge,
		);
		expect(discordAuthorization.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);

		// The fake Discord login returns an authorization code to Access, which then
		// calls the Worker's token endpoint with the original PKCE verifier.
		const upstream = vi.fn();
		upstream.mockResolvedValueOnce(
			Response.json({
				access_token: "fake-discord-access-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "identify email",
			}),
		);
		upstream.mockResolvedValueOnce(
			Response.json({
				id: "987654321012345678",
				username: "lala",
				global_name: "Lala",
				email: "lala@example.test",
				verified: true,
			}),
		);
		upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", upstream);
		const tokenRequest = new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code: "fake-discord-authorization-code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			grant_type: "authorization_code",
		});
		const tokenResponse = await fetchWorker(
			new Request(`${ISSUER}/token`, { method: "POST", body: tokenRequest }),
			env,
			{},
		);
		const discordTokenRequest = new URLSearchParams(
			upstream.mock.calls[0]![1]!.body as string,
		);
		const result = (await tokenResponse.json()) as {
			id_token: string;
			access_token: string;
		};
		const verified = await jose.jwtVerify(
			result.id_token,
			await jose.importJWK(publicJwk, "RS256"),
			{ issuer: ISSUER, audience: CLIENT_ID },
		);

		expect(tokenResponse.status).toBe(200);
		expect(discordTokenRequest.get("code_verifier")).toBe(verifier);
		expect(await challengeFor(discordTokenRequest.get("code_verifier")!)).toBe(
			challenge,
		);
		expect(verified.payload.nonce).toBe(accessNonce);
		expect(verified.payload.sub).toBe("987654321012345678");
		expect(result.access_token).not.toBe("fake-discord-access-token");
		expect(kv.values.has(`oidc:pending:${challenge}`)).toBe(false);
	});

	it("publishes active and retiring signing keys", async () => {
		const { privateJwk, publicJwk } = await makeKeys();
		const retired = {
			...publicJwk,
			kid: "key-retired",
			alg: "RS256",
			use: "sig",
		};
		const env = {
			...makeEnv(new MemoryKv(), privateJwk),
			OIDC_RETIRING_PUBLIC_KEYS: JSON.stringify([retired]),
		};
		const response = await fetchWorker(
			new Request(`${ISSUER}/jwks.json`),
			env,
			{},
		);
		const jwks = (await response.json()) as { keys: Array<{ kid?: string }> };
		expect(jwks.keys.map((key) => key.kid)).toEqual([
			"key-active",
			"key-retired",
		]);
	});
});
