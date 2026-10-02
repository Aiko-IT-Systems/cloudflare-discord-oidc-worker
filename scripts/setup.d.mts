export interface SetupZone {
	id: string;
	name: string;
}

export interface SetupD1Database {
	name: string;
	uuid: string;
}

export interface WorkerProfileOptions {
	base: Record<string, unknown>;
	accountId: string;
	zone: SetupZone;
	workerUrl: string;
	clientId: string;
	callbackUrl: string;
	guildIds: string[];
	roleSource: "cache" | "user" | "bot";
	backend: "kv" | "d1";
	kvId: string;
	d1?: SetupD1Database;
	includeEmail: boolean;
	fallbackEmail: string;
}

export interface SetupWorkerProfile {
	account_id: string;
	routes: Array<Record<string, unknown>>;
	d1_databases: Array<Record<string, unknown>>;
	vars: Record<string, string>;
	[key: string]: unknown;
}

export function parseJsonc(source: string): Record<string, unknown>;
export function mergeObjects<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T;
export function buildWorkerProfile(options: WorkerProfileOptions): SetupWorkerProfile;
export function redactSecrets(value: unknown): unknown;
export function fetchGuildRoles(
	guildId: string,
	botToken: string,
	fetchImpl?: typeof fetch,
): Promise<Array<{ id: string; name: string; [key: string]: unknown }>>;
