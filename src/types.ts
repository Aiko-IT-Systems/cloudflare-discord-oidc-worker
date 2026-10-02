export interface AppConfig {
	clientId: string;
	issuer: string;
	redirectUris: string[];
	roleGuildIds: string[];
	includeEmail: boolean;
	fallbackEmail: string;
	cacheBackend: "kv" | "d1";
	roleSource: "cache" | "user" | "bot";
}

export type ScopeMode = "identify" | "email" | "guilds" | "roles";
export type RoleRecord = Record<string, string[]>;
export type RoleClaims = Record<`roles:${string}`, string[]>;
export type OidcJwk = JsonWebKey & { kid: string; alg: "RS256"; use: "sig" };

export interface DiscordTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
}

export interface DiscordUser {
	id: string;
	username: string;
	global_name?: string | null;
	avatar?: string | null;
	email?: string | null;
	verified?: boolean;
}

export interface DiscordGuild {
	id: string;
}

export interface DiscordGuildMember {
	user?: { id?: string };
	roles?: string[];
}
