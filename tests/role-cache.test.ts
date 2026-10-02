import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const GUILD_ID = "12345678901234567";
const scheduledWorker = worker.scheduled! as unknown as (
	controller: object,
	env: object,
) => Promise<void>;

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

class MemoryD1Statement {
	values: unknown[] = [];
	constructor(
		private readonly sql: string,
		private readonly db: MemoryD1,
	) {}
	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}
	async run(): Promise<{ meta: { changes: number } }> {
		if (this.sql.startsWith("INSERT INTO role_members"))
			this.db.members.push(this.values);
		if (this.sql.startsWith("INSERT INTO active_role_snapshots"))
			this.db.active.set(String(this.values[0]), String(this.values[1]));
		return { meta: { changes: 0 } };
	}
	async first<T>(): Promise<T | null> {
		return null;
	}
}

class MemoryD1 {
	members: unknown[][] = [];
	active = new Map<string, string>();
	prepare(sql: string): MemoryD1Statement {
		return new MemoryD1Statement(sql, this);
	}
	async batch(statements: MemoryD1Statement[]): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const statement of statements) results.push(await statement.run());
		return results;
	}
}

function makeEnv(kv: MemoryKv, backend: "kv" | "d1", db?: MemoryD1) {
	return {
		KV: kv,
		...(db ? { DB: db } : {}),
		CLIENT_ID: "123456789012345678",
		ISSUER: "https://oidc.example.test",
		REDIRECT_URIS:
			'["https://team.cloudflareaccess.com/cdn-cgi/access/callback"]',
		ROLE_GUILD_IDS: JSON.stringify([GUILD_ID]),
		ROLE_SOURCE: "cache",
		CACHE_BACKEND: backend,
		INCLUDE_EMAIL: "true",
		FALLBACK_EMAIL: "oauth@discord.com",
		OIDC_RETIRING_PUBLIC_KEYS: "[]",
		DISCORD_TOKEN: "test-bot-token",
	};
}

async function runScheduled(env: object): Promise<void> {
	await scheduledWorker({}, env);
}

describe("role cache snapshots", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("paginates Discord members and publishes a complete KV snapshot", async () => {
		const kv = new MemoryKv();
		const fetchMock = vi.fn();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ retry_after: 0.001 }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			}),
		);
		fetchMock.mockResolvedValueOnce(
			Response.json([{ user: { id: "10000000000000001" }, roles: ["role-a"] }]),
		);
		fetchMock.mockResolvedValueOnce(Response.json([]));
		vi.stubGlobal("fetch", fetchMock);
		await runScheduled(makeEnv(kv, "kv"));
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(JSON.parse(kv.values.get(`roles:${GUILD_ID}`)!).members).toEqual({
			"10000000000000001": ["role-a"],
		});
	});

	it("publishes D1 role rows by switching the active snapshot only after writes finish", async () => {
		const db = new MemoryD1();
		const fetchMock = vi.fn();
		fetchMock.mockResolvedValueOnce(
			Response.json([{ user: { id: "10000000000000002" }, roles: ["role-b"] }]),
		);
		fetchMock.mockResolvedValueOnce(Response.json([]));
		vi.stubGlobal("fetch", fetchMock);
		await runScheduled(makeEnv(new MemoryKv(), "d1", db));
		expect(db.members).toHaveLength(1);
		const snapshotId = db.active.get(GUILD_ID);
		expect(snapshotId).toBeDefined();
		expect(db.members[0]).toEqual([
			GUILD_ID,
			"10000000000000002",
			snapshotId,
			'["role-b"]',
		]);
	});

	it("keeps the existing D1 snapshot active when a later page fails", async () => {
		vi.useFakeTimers();
		const db = new MemoryD1();
		db.active.set(GUILD_ID, "known-good-snapshot");
		const fetchMock = vi.fn();
		fetchMock.mockResolvedValueOnce(
			Response.json([{ user: { id: "10000000000000003" }, roles: [] }]),
		);
		fetchMock.mockResolvedValueOnce(
			new Response("temporarily unavailable", { status: 503 }),
		);
		fetchMock.mockResolvedValueOnce(
			new Response("temporarily unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const refresh = runScheduled(makeEnv(new MemoryKv(), "d1", db));
		const rejected = expect(refresh).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(10_000);
		await rejected;
		expect(db.active.get(GUILD_ID)).toBe("known-good-snapshot");
		expect(log).toHaveBeenCalled();
	});
});
