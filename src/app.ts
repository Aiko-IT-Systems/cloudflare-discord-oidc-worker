import { Hono } from "hono";
import * as jose from "jose";
import { validateClient } from "./client-auth";
import { getConfig, getScopes, isScopeMode } from "./config";
import {
	DISCORD_API,
	DISCORD_AUTHORIZE,
	USER_AGENT,
	discordHeaders,
	discordOAuthErrorCode,
	parseDiscordGuilds,
	parseDiscordMember,
	parseDiscordToken,
	parseDiscordUser,
	readDiscordJson,
	requireDiscordOk,
	requestDiscord,
} from "./discord";
import { UpstreamError, logError, logWarning } from "./errors";
import {
	ID_TOKEN_TTL_SECONDS,
	PENDING_AUTH_TTL_SECONDS,
	loadSigningKey,
	pendingNonceKey,
	sha256Base64Url,
	validateCodeVerifier,
} from "./protocol";
import { readCachedRoles } from "./role-cache";
import type {
	AppConfig,
	DiscordGuildMember,
	DiscordTokenResponse,
	DiscordUser,
	RoleClaims,
} from "./types";

type AppEnv = { Bindings: Env };
const app = new Hono<AppEnv>();
const TOKEN_PROCESSING_DEADLINE_MS = 30_000;
const MAX_ACCESS_STATE_LENGTH = 8192;

function tokenError(status: number, error: string): Response {
	return Response.json(
		{ error },
		{ status, headers: { "Cache-Control": "no-store" } },
	);
}

function upstreamErrorResponse(error: unknown): Response {
	logError("token_processing_failed", error);
	if (error instanceof UpstreamError && error.status === 429)
		return tokenError(503, "server_error");
	if (error instanceof UpstreamError && error.timedOut)
		return tokenError(504, "server_error");
	return tokenError(502, "server_error");
}

function providerConfig(env: Env, operation: string): AppConfig | null {
	try {
		return getConfig(env);
	} catch (error) {
		logError("provider_configuration_invalid", error, { operation });
		return null;
	}
}

async function revokeDiscordToken(
	accessToken: string,
	clientId: string,
	clientSecret: string,
): Promise<void> {
	const form = new URLSearchParams({
		token: accessToken,
		token_type_hint: "access_token",
		client_id: clientId,
		client_secret: clientSecret,
	});
	try {
		const response = await requestDiscord(
			`${DISCORD_API}/oauth2/token/revoke`,
			{
				method: "POST",
				body: form,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": USER_AGENT,
				},
			},
			{
				operation: "oauth_token_revocation",
				deadline: Date.now() + 5_000,
				maxRateLimitRetries: 0,
				maxRetryAfterMs: 0,
			},
		);
		requireDiscordOk(response, "oauth_token_revocation");
	} catch (error) {
		logWarning("discord_token_revocation_failed", {
			operation: "oauth_token_revocation",
			...(error instanceof UpstreamError
				? {
						status: error.status,
						timedOut: error.timedOut,
						retryAfterMs: error.retryAfterMs,
					}
				: { errorName: error instanceof Error ? error.name : "UnknownError" }),
		});
	}
}

app.onError((error, c) => {
	logError("request_failed", error, {
		method: c.req.method,
		path: new URL(c.req.url).pathname,
	});
	return c.json({ error: "server_error" }, 500, {
		"Cache-Control": "no-store",
	});
});

app.get("/.well-known/openid-configuration", (c) => {
	const config = providerConfig(c.env, "openid_configuration");
	if (!config) return c.text("Provider configuration error", 500);
	const base = config.issuer;
	return c.json({
		issuer: base,
		authorization_endpoint: `${base}/authorize/identify`,
		token_endpoint: `${base}/token`,
		jwks_uri: `${base}/jwks.json`,
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		scopes_supported: [
			"openid",
			"profile",
			"email",
			"guilds",
			"guilds.members.read",
		],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: [
			"client_secret_basic",
			"client_secret_post",
		],
	});
});

function nonceFromAccessState(state: string): string | undefined {
	// Cloudflare Access wraps its nonce in the final, base64url-encoded state
	// segment instead of sending it as a top-level authorization parameter.
	if (state.length > MAX_ACCESS_STATE_LENGTH) return undefined;
	const separator = state.lastIndexOf(".");
	if (separator < 0) return undefined;
	let encoded = state.slice(separator + 1);
	// Access double-encodes the base64 padding in its state query parameter,
	// so URLSearchParams leaves a trailing `%3D` here after its first decode.
	try {
		encoded = decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return undefined;

	try {
		const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1)
			bytes[index] = binary.charCodeAt(index);
		const decoded = new TextDecoder().decode(bytes);
		const candidates = [decoded];
		try {
			candidates.push(decodeURIComponent(decoded));
		} catch {
			// The payload may already be plain JSON rather than URL-encoded JSON.
		}

		for (const candidate of candidates) {
			try {
				const payload: unknown = JSON.parse(candidate);
				if (
					payload &&
					typeof payload === "object" &&
					"nonce" in payload &&
					typeof payload.nonce === "string" &&
					payload.nonce.length > 0 &&
					payload.nonce.length <= 256
				)
					return payload.nonce;
			} catch {
				// Ignore non-JSON state payloads and let authorization validation fail.
			}
		}
	} catch {
		// Ignore malformed base64url state and let authorization validation fail.
	}
	return undefined;
}

app.get("/authorize/:mode", async (c) => {
	const config = providerConfig(c.env, "authorize");
	if (!config) return c.text("Provider configuration error", 500);
	const mode = c.req.param("mode");
	const clientId = c.req.query("client_id");
	const redirectUri = c.req.query("redirect_uri");
	const state = c.req.query("state");
	const nonce =
		c.req.query("nonce") ?? (state ? nonceFromAccessState(state) : undefined);
	const challenge = c.req.query("code_challenge");
	const method = c.req.query("code_challenge_method");
	if (
		!isScopeMode(mode) ||
		c.req.query("response_type") !== "code" ||
		clientId !== config.clientId ||
		!redirectUri ||
		!config.redirectUris.includes(redirectUri)
	)
		return c.text("Invalid authorization request", 400);
	if (
		!state ||
		state.length > MAX_ACCESS_STATE_LENGTH ||
		!nonce ||
		nonce.length > 256 ||
		!challenge ||
		!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
		method !== "S256"
	)
		return c.text("Authorization requires state, nonce, and S256 PKCE", 400);

	await c.env.KV.put(
		pendingNonceKey(challenge),
		JSON.stringify({ nonce, mode }),
		{
			expirationTtl: PENDING_AUTH_TTL_SECONDS,
		},
	);
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: getScopes(mode, config.includeEmail, config.roleSource).join(" "),
		state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	return c.redirect(`${DISCORD_AUTHORIZE}?${params}`);
});

app.post("/token", async (c) => {
	const config = providerConfig(c.env, "token");
	if (!config) return tokenError(500, "server_error");
	const contentType = c.req
		.header("Content-Type")
		?.split(";", 1)[0]
		.trim()
		.toLowerCase();
	if (contentType !== "application/x-www-form-urlencoded")
		return tokenError(400, "invalid_request");
	let body: Record<string, unknown>;
	try {
		body = (await c.req.parseBody()) as Record<string, unknown>;
	} catch {
		return tokenError(400, "invalid_request");
	}
	if (
		!(await validateClient(
			c.req.header("Authorization"),
			body,
			c.env,
			config.clientId,
		))
	)
		return tokenError(401, "invalid_client");
	const code = typeof body.code === "string" ? body.code : "";
	const redirectUri =
		typeof body.redirect_uri === "string" ? body.redirect_uri : "";
	const verifier =
		typeof body.code_verifier === "string" ? body.code_verifier : "";
	if (
		body.grant_type !== "authorization_code" ||
		!code ||
		code.length > 2048 ||
		!redirectUri ||
		!config.redirectUris.includes(redirectUri) ||
		!validateCodeVerifier(verifier)
	)
		return tokenError(400, "invalid_request");

	const challenge = await sha256Base64Url(verifier);
	const pending = await c.env.KV.get<{ nonce?: unknown; mode?: unknown }>(
		pendingNonceKey(challenge),
		"json",
	);
	if (
		typeof pending?.nonce !== "string" ||
		typeof pending.mode !== "string" ||
		!isScopeMode(pending.mode)
	)
		return tokenError(400, "invalid_grant");
	const form = new URLSearchParams({
		client_id: config.clientId,
		client_secret: c.env.DISCORD_CLIENT_SECRET ?? "",
		redirect_uri: redirectUri,
		code,
		code_verifier: verifier,
		grant_type: "authorization_code",
	});
	const tokenOperation = "oauth_token_exchange";
	const tokenDeadline = Date.now() + TOKEN_PROCESSING_DEADLINE_MS;
	let tokenResponse: Response;
	try {
		tokenResponse = await requestDiscord(
			`${DISCORD_API}/oauth2/token`,
			{
				method: "POST",
				body: form,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": USER_AGENT,
				},
			},
			{ operation: tokenOperation, deadline: tokenDeadline },
		);
	} catch (error) {
		return upstreamErrorResponse(error);
	}
	if (!tokenResponse.ok) {
		const errorCode = await discordOAuthErrorCode(tokenResponse);
		if (tokenResponse.status === 400 && errorCode === "invalid_grant")
			return tokenError(400, "invalid_grant");
		return upstreamErrorResponse(
			new UpstreamError(
				"Discord rejected the token exchange",
				tokenOperation,
				tokenResponse.status,
			),
		);
	}

	let discordToken: DiscordTokenResponse;
	let discordAccessToken: string | null = null;
	let user: DiscordUser;
	let guildIds: string[] = [];
	const roleClaims: RoleClaims = {};
	try {
		discordToken = await readDiscordJson(
			tokenResponse,
			tokenOperation,
			parseDiscordToken,
		);
		discordAccessToken = discordToken.access_token;
		const userResponse = await requestDiscord(
			`${DISCORD_API}/users/@me`,
			{ headers: discordHeaders(discordToken.access_token, "Bearer") },
			{ operation: "current_user", deadline: tokenDeadline },
		);
		requireDiscordOk(userResponse, "current_user");
		user = await readDiscordJson(
			userResponse,
			"current_user",
			parseDiscordUser,
		);
		const returnedScopes = new Set(
			discordToken.scope.split(/\s+/).filter(Boolean),
		);

		if (returnedScopes.has("guilds")) {
			const guildResponse = await requestDiscord(
				`${DISCORD_API}/users/@me/guilds`,
				{ headers: discordHeaders(discordToken.access_token, "Bearer") },
				{ operation: "current_user_guilds", deadline: tokenDeadline },
			);
			requireDiscordOk(guildResponse, "current_user_guilds");
			guildIds = (
				await readDiscordJson(
					guildResponse,
					"current_user_guilds",
					parseDiscordGuilds,
				)
			).map((guild) => guild.id);
		}

		if (pending.mode === "roles" && !returnedScopes.has("guilds"))
			return tokenError(403, "access_denied");
		if (
			pending.mode === "roles" &&
			config.roleSource === "user" &&
			!returnedScopes.has("guilds.members.read")
		)
			return tokenError(403, "access_denied");

		if (pending.mode === "roles" && config.roleSource === "cache") {
			for (const guildId of config.roleGuildIds) {
				if (!guildIds.includes(guildId)) continue;
				const roles = await readCachedRoles(c.env, guildId, user.id);
				if (roles) roleClaims[`roles:${guildId}`] = roles;
			}
		} else if (pending.mode === "roles" && config.roleSource === "user") {
			for (const guildId of config.roleGuildIds) {
				if (!guildIds.includes(guildId)) continue;
				const memberResponse = await requestDiscord(
					`${DISCORD_API}/users/@me/guilds/${guildId}/member`,
					{ headers: discordHeaders(discordToken.access_token, "Bearer") },
					{
						operation: "current_user_guild_member",
						deadline: tokenDeadline,
						context: { guildId },
					},
				);
				if (memberResponse.status === 404) continue;
				requireDiscordOk(memberResponse, "current_user_guild_member", {
					guildId,
				});
				const member = await readDiscordJson(
					memberResponse,
					"current_user_guild_member",
					parseDiscordMember,
					{ guildId },
				);
				roleClaims[`roles:${guildId}`] = member.roles ?? [];
			}
		} else if (
			pending.mode === "roles" &&
			config.roleSource === "bot" &&
			config.roleGuildIds.length > 0
		) {
			if (!c.env.DISCORD_TOKEN)
				throw new UpstreamError(
					"DISCORD_TOKEN is required for bot role lookup",
					"bot_role_lookup",
				);
			for (const guildId of config.roleGuildIds) {
				if (!guildIds.includes(guildId)) continue;
				const memberResponse = await requestDiscord(
					`${DISCORD_API}/guilds/${guildId}/members/${user.id}`,
					{ headers: discordHeaders(c.env.DISCORD_TOKEN, "Bot") },
					{
						operation: "bot_guild_member",
						deadline: tokenDeadline,
						context: { guildId },
					},
				);
				if (memberResponse.status === 404) continue;
				requireDiscordOk(memberResponse, "bot_guild_member", { guildId });
				const member: DiscordGuildMember = await readDiscordJson(
					memberResponse,
					"bot_guild_member",
					parseDiscordMember,
					{ guildId },
				);
				roleClaims[`roles:${guildId}`] = member.roles ?? [];
			}
		}

		if (
			!user.id ||
			!user.username ||
			(config.includeEmail && (!user.email || !user.verified))
		)
			return tokenError(400, "access_denied");
		if (Date.now() >= tokenDeadline)
			throw new UpstreamError(
				"Identity processing exceeded its time budget",
				"token_processing",
				null,
				null,
				true,
			);
		const signing = await loadSigningKey(c.env);
		const email = config.includeEmail ? user.email! : config.fallbackEmail;
		const tokenScopes = [
			"openid",
			"profile",
			...(config.includeEmail ? ["email"] : []),
			...(returnedScopes.has("guilds") ? ["guilds"] : []),
			...(returnedScopes.has("guilds.members.read")
				? ["guilds.members.read"]
				: []),
		];
		const claims: jose.JWTPayload & Record<string, unknown> = {
			iss: config.issuer,
			sub: user.id,
			id: user.id,
			aud: config.clientId,
			nonce: pending.nonce,
			username: user.username,
			global_name: user.global_name ?? null,
			preferred_username: user.username,
			name: user.global_name ?? user.username,
			...(user.avatar
				? {
						picture: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}`,
					}
				: {}),
			email,
			email_verified: config.includeEmail ? Boolean(user.verified) : false,
			guilds: guildIds,
			...roleClaims,
		};
		const idToken = await new jose.SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", typ: "JWT", kid: signing.kid })
			.setIssuedAt()
			.setExpirationTime(`${ID_TOKEN_TTL_SECONDS}s`)
			.setAudience(config.clientId)
			.sign(signing.key);
		await c.env.KV.delete(pendingNonceKey(challenge));
		return c.json(
			{
				access_token: crypto.randomUUID(),
				token_type: "Bearer",
				expires_in: ID_TOKEN_TTL_SECONDS,
				scope: tokenScopes.join(" "),
				id_token: idToken,
			},
			200,
			{ "Cache-Control": "no-store", Pragma: "no-cache" },
		);
	} catch (error) {
		return upstreamErrorResponse(error);
	} finally {
		if (discordAccessToken && typeof c.env.DISCORD_CLIENT_SECRET === "string")
			await revokeDiscordToken(
				discordAccessToken,
				config.clientId,
				c.env.DISCORD_CLIENT_SECRET,
			);
	}
});

app.get("/jwks.json", async (c) => {
	try {
		const signing = await loadSigningKey(c.env);
		return c.json({ keys: signing.jwks }, 200, {
			"Cache-Control": "public, max-age=300",
		});
	} catch (error) {
		logError("jwks_failed", error);
		return c.text("Provider configuration error", 500);
	}
});

export default app;
