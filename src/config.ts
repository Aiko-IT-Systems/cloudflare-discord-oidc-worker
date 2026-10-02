import type { AppConfig, ScopeMode } from "./types";

export function parseJsonArray(
	value: string | undefined,
	name: string,
): unknown[] {
	if (!value) throw new Error(`Missing ${name}`);
	const result: unknown = JSON.parse(value);
	if (!Array.isArray(result)) throw new Error(`${name} must be a JSON array`);
	return result;
}

export function getConfig(env: Env): AppConfig {
	const cacheBackend: string = env.CACHE_BACKEND ?? "kv";
	if (cacheBackend !== "kv" && cacheBackend !== "d1")
		throw new Error("CACHE_BACKEND must be kv or d1");
	const roleSource: string = env.ROLE_SOURCE ?? "cache";
	if (roleSource !== "cache" && roleSource !== "user" && roleSource !== "bot")
		throw new Error("ROLE_SOURCE must be cache, user, or bot");
	const clientId = env.CLIENT_ID;
	const issuer = env.ISSUER?.replace(/\/$/, "");
	if (!clientId || !/^\d{17,20}$/.test(clientId))
		throw new Error("CLIENT_ID must be a Discord application ID");
	if (!issuer) throw new Error("ISSUER must be an HTTPS URL");
	const issuerUrl = new URL(issuer);
	if (
		issuerUrl.protocol !== "https:" ||
		issuerUrl.username ||
		issuerUrl.password ||
		issuerUrl.search ||
		issuerUrl.hash
	) {
		throw new Error(
			"ISSUER must be a canonical HTTPS URL without credentials, query, or fragment",
		);
	}
	const redirectValues = parseJsonArray(env.REDIRECT_URIS, "REDIRECT_URIS");
	if (redirectValues.some((uri) => typeof uri !== "string"))
		throw new Error("REDIRECT_URIS must contain only strings");
	const redirectUris = redirectValues as string[];
	const allowLocalHttpRedirects = env.ALLOW_LOCAL_HTTP_REDIRECTS === "true";
	if (
		redirectUris.some(
			(uri) => !isAllowedRedirectUri(uri, allowLocalHttpRedirects),
		)
	) {
		throw new Error(
			"REDIRECT_URIS must contain valid HTTPS URLs (or loopback HTTP URLs in local test mode)",
		);
	}
	const roleGuildValues = parseJsonArray(
		env.ROLE_GUILD_IDS ?? "[]",
		"ROLE_GUILD_IDS",
	);
	if (
		roleGuildValues.some(
			(guildId) => typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId),
		) ||
		new Set(roleGuildValues).size !== roleGuildValues.length
	) {
		throw new Error("ROLE_GUILD_IDS must contain unique Discord guild IDs");
	}
	const roleGuildIds = roleGuildValues as string[];
	return {
		clientId,
		issuer,
		redirectUris,
		roleGuildIds,
		includeEmail: String(env.INCLUDE_EMAIL) !== "false",
		fallbackEmail: env.FALLBACK_EMAIL || "oauth@discord.com",
		cacheBackend,
		roleSource,
	};
}

function isAllowedRedirectUri(uri: string, allowLocalHttp: boolean): boolean {
	try {
		const url = new URL(uri);
		if (url.protocol === "https:" && !url.username && !url.password)
			return true;
		return (
			allowLocalHttp &&
			url.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

export function isScopeMode(value: string): value is ScopeMode {
	return (
		value === "identify" ||
		value === "email" ||
		value === "guilds" ||
		value === "roles"
	);
}

export function getScopes(
	mode: ScopeMode,
	includeEmail: boolean,
	roleSource: AppConfig["roleSource"],
): string[] {
	const scopes = ["identify"];
	if (includeEmail) scopes.push("email");
	if (mode === "guilds" || mode === "roles") scopes.push("guilds");
	if (mode === "roles" && roleSource === "user")
		scopes.push("guilds.members.read");
	return scopes;
}
