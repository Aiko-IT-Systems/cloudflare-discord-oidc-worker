import { getConfig } from "./config";
import {
	DISCORD_API,
	discordHeaders,
	parseDiscordMemberPage,
	readDiscordJson,
	requireDiscordOk,
	requestDiscord,
} from "./discord";
import { UpstreamError, logError, logWarning } from "./errors";
import type { DiscordGuildMember, RoleRecord } from "./types";

export const ROLE_SNAPSHOT_MAX_AGE_SECONDS = 7200;
const KV_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
const ROLE_REFRESH_DEADLINE_MS = 14 * 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 5;

function getD1Database(env: Env): D1Database | undefined {
	return (env as Env & { DB?: D1Database }).DB;
}

function assertRefreshTime(deadline: number, guildId?: string): void {
	if (Date.now() >= deadline)
		throw new UpstreamError(
			"Role snapshot refresh reached its execution deadline",
			"role_snapshot_refresh",
			null,
			null,
			true,
			guildId ? { guildId } : {},
		);
}

function parseRoleList(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((role) => typeof role !== "string"))
		throw new Error("Invalid cached role list");
	return value;
}

async function withStorageContext<T>(
	operation: string,
	guildId: string,
	backend: "kv" | "d1",
	work: () => Promise<T>,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof UpstreamError) throw error;
		throw new UpstreamError(
			"Role snapshot storage operation failed",
			operation,
			null,
			null,
			false,
			{
				guildId,
				backend,
				storageErrorName: error instanceof Error ? error.name : "UnknownError",
			},
		);
	}
}

export async function getRolesFromCache(
	env: Env,
	guildId: string,
	userId: string,
): Promise<string[] | null> {
	const config = getConfig(env);
	if (config.cacheBackend === "d1") {
		const db = getD1Database(env);
		if (!db) throw new Error("The D1 cache backend requires the DB binding");
		const session = db.withSession("first-primary");
		const activeSnapshot = await session
			.prepare(
				`SELECT snapshot_id, updated_at
				 FROM active_role_snapshots
				 WHERE guild_id = ? AND updated_at >= ?`,
			)
			.bind(
				guildId,
				Math.floor(Date.now() / 1000) - ROLE_SNAPSHOT_MAX_AGE_SECONDS,
			)
			.first<{ snapshot_id: string; updated_at: number }>();
		if (!activeSnapshot) return null;
		const row = await session
			.prepare(
				`SELECT roles_json
				 FROM role_members
				 WHERE guild_id = ? AND user_id = ? AND snapshot_id = ?`,
			)
			.bind(guildId, userId, activeSnapshot.snapshot_id)
			.first<{ roles_json: string }>();
		return row ? parseRoleList(JSON.parse(row.roles_json)) : null;
	}
	const cache = await env.KV.get<unknown>(`roles:${guildId}`, "json");
	if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
	const snapshot = cache as { updatedAt?: unknown; members?: unknown };
	if (
		typeof snapshot.updatedAt !== "number" ||
		snapshot.updatedAt < Date.now() / 1000 - ROLE_SNAPSHOT_MAX_AGE_SECONDS ||
		!snapshot.members ||
		typeof snapshot.members !== "object" ||
		Array.isArray(snapshot.members)
	)
		return null;
	const members = snapshot.members as Record<string, unknown>;
	return Object.hasOwn(members, userId) ? parseRoleList(members[userId]) : null;
}

function fetchGuildMembers(
	env: Env,
	guildId: string,
	deadline: number,
): AsyncGenerator<DiscordGuildMember> {
	const generator = async function* (): AsyncGenerator<DiscordGuildMember> {
		let after: string | undefined;
		let nextRequestDelayMs = 0;
		while (true) {
			if (nextRequestDelayMs > 0) {
				if (Date.now() + nextRequestDelayMs >= deadline)
					throw new UpstreamError(
						"Discord rate limit exceeds the remaining role snapshot refresh window",
						"guild_member_page",
						429,
						nextRequestDelayMs,
						true,
						{ guildId },
					);
				await new Promise((resolve) => setTimeout(resolve, nextRequestDelayMs));
				nextRequestDelayMs = 0;
			}
			assertRefreshTime(deadline, guildId);
			const params = new URLSearchParams({ limit: "1000" });
			if (after) params.set("after", after);
			const response = await requestDiscord(
				`${DISCORD_API}/guilds/${guildId}/members?${params}`,
				{ headers: discordHeaders(env.DISCORD_TOKEN ?? "", "Bot") },
				{
					operation: "guild_member_page",
					deadline,
					maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
					maxRetryAfterMs: Infinity,
					context: { guildId },
				},
			);
			requireDiscordOk(response, "guild_member_page", { guildId });
			if (response.headers.get("X-RateLimit-Remaining") === "0") {
				const header = response.headers.get("X-RateLimit-Reset-After");
				const resetAfter = header === null ? Number.NaN : Number(header);
				if (Number.isFinite(resetAfter) && resetAfter > 0)
					nextRequestDelayMs = resetAfter * 1000;
			}
			const members = await readDiscordJson(
				response,
				"guild_member_page",
				parseDiscordMemberPage,
				{ guildId },
			);
			if (members.length === 0) return;
			for (const member of members) yield member;
			const next = members.at(-1)?.user?.id;
			if (!next)
				throw new UpstreamError(
					"Discord member page omitted the final user ID",
					"guild_member_page",
					response.status,
				);
			after = next;
		}
	};
	return generator();
}

async function cacheGuildInKv(
	env: Env,
	guildId: string,
	deadline: number,
): Promise<number> {
	const entries: string[] = [];
	let encodedBytes = 2;
	for await (const member of fetchGuildMembers(env, guildId, deadline)) {
		assertRefreshTime(deadline, guildId);
		const userId = member.user?.id;
		if (!userId) continue;
		const roles = parseRoleList(member.roles);
		const entry = `${JSON.stringify(userId)}:${JSON.stringify(roles)}`;
		encodedBytes +=
			new TextEncoder().encode(entry).byteLength + (entries.length ? 1 : 0);
		if (encodedBytes > KV_SNAPSHOT_MAX_BYTES)
			throw new Error(
				`Role snapshot for guild ${guildId} exceeds the KV size budget`,
			);
		entries.push(entry);
	}
	assertRefreshTime(deadline, guildId);
	const snapshot = `{"updatedAt":${Math.floor(Date.now() / 1000)},"members":{${entries.join(",")}}}`;
	await withStorageContext("role_snapshot_write", guildId, "kv", () =>
		env.KV.put(`roles:${guildId}`, snapshot, {
			expirationTtl: ROLE_SNAPSHOT_MAX_AGE_SECONDS,
		}),
	);
	return entries.length;
}

async function cacheGuildInD1(
	env: Env,
	guildId: string,
	deadline: number,
): Promise<number> {
	const db = getD1Database(env);
	if (!db) throw new Error("The D1 cache backend requires the DB binding");
	const snapshotId = crypto.randomUUID();
	let count = 0;
	let batch: D1PreparedStatement[] = [];
	for await (const member of fetchGuildMembers(env, guildId, deadline)) {
		assertRefreshTime(deadline, guildId);
		const userId = member.user?.id;
		if (!userId) continue;
		batch.push(
			db
				.prepare(
					"INSERT INTO role_members (guild_id, user_id, snapshot_id, roles_json) VALUES (?, ?, ?, ?)",
				)
				.bind(
					guildId,
					userId,
					snapshotId,
					JSON.stringify(parseRoleList(member.roles)),
				),
		);
		count += 1;
		if (batch.length === 100) {
			await withStorageContext("role_snapshot_write", guildId, "d1", () =>
				db.batch(batch),
			);
			batch = [];
		}
	}
	if (batch.length)
		await withStorageContext("role_snapshot_write", guildId, "d1", () =>
			db.batch(batch),
		);
	assertRefreshTime(deadline, guildId);
	await withStorageContext("role_snapshot_activate", guildId, "d1", () =>
		db
			.prepare(
				`INSERT INTO active_role_snapshots (guild_id, snapshot_id, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(guild_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`,
			)
			.bind(guildId, snapshotId, Math.floor(Date.now() / 1000))
			.run(),
	);
	let cleanupComplete = false;
	try {
		for (let batchIndex = 0; batchIndex < 100; batchIndex += 1) {
			if (Date.now() >= deadline) break;
			const cleanup = await db
				.prepare(
					`DELETE FROM role_members WHERE rowid IN (
					SELECT rowid FROM role_members WHERE guild_id = ? AND snapshot_id != ? LIMIT 1000
				)`,
				)
				.bind(guildId, snapshotId)
				.run();
			if (!cleanup.meta.changes) {
				cleanupComplete = true;
				break;
			}
		}
	} catch (error) {
		logError(
			"role_snapshot_cleanup_failed",
			error instanceof UpstreamError
				? error
				: new UpstreamError(
						"Role snapshot cleanup failed",
						"role_snapshot_cleanup",
						null,
						null,
						false,
						{
							guildId,
							backend: "d1",
							storageErrorName:
								error instanceof Error ? error.name : "UnknownError",
						},
					),
		);
	}
	if (!cleanupComplete)
		logWarning("role_snapshot_cleanup_deferred", { guildId, backend: "d1" });
	return count;
}

export async function cacheRoles(env: Env): Promise<void> {
	const config = getConfig(env);
	if (config.roleSource !== "cache") return;
	if (config.roleGuildIds.length === 0) {
		return;
	}
	if (!env.DISCORD_TOKEN)
		throw new UpstreamError(
			"DISCORD_TOKEN is required to refresh role snapshots",
			"role_snapshot_refresh_configuration",
		);
	const startedAt = Date.now();
	const deadline = startedAt + ROLE_REFRESH_DEADLINE_MS;
	console.log(
		JSON.stringify({
			event: "role_snapshot_refresh_started",
			guildCount: config.roleGuildIds.length,
			backend: config.cacheBackend,
		}),
	);
	for (const guildId of config.roleGuildIds) {
		assertRefreshTime(deadline, guildId);
		const count =
			config.cacheBackend === "d1"
				? await cacheGuildInD1(env, guildId, deadline)
				: await cacheGuildInKv(env, guildId, deadline);
		console.log(
			JSON.stringify({
				event: "role_snapshot_published",
				guildId,
				memberCount: count,
				backend: config.cacheBackend,
				elapsedMs: Date.now() - startedAt,
			}),
		);
	}
	console.log(
		JSON.stringify({
			event: "role_snapshot_refresh_completed",
			guildCount: config.roleGuildIds.length,
			backend: config.cacheBackend,
			elapsedMs: Date.now() - startedAt,
		}),
	);
}

export async function readCachedRoles(
	env: Env,
	guildId: string,
	userId: string,
): Promise<string[] | null> {
	try {
		return await getRolesFromCache(env, guildId, userId);
	} catch {
		throw new UpstreamError(
			"Role cache read failed",
			"role_cache_read",
			null,
			null,
			false,
			{ guildId, backend: env.CACHE_BACKEND ?? "kv" },
		);
	}
}
