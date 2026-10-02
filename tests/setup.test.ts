import { describe, expect, it } from "vitest";
import {
	buildWorkerProfile,
	fetchGuildRoles,
	mergeObjects,
	parseJsonc,
	redactSecrets,
} from "../scripts/setup.mjs";

describe("setup wizard helpers", () => {
	it("parses comments and trailing commas in profile JSONC", () => {
		expect(parseJsonc('{\n // local profile\n "vars": {"FLAG": true,},\n}')).toEqual({
			vars: { FLAG: true },
		});
	});

	it("merges nested profile objects while replacing arrays", () => {
		expect(mergeObjects({ vars: { A: "1", B: "2" }, routes: [{ old: true }] }, {
			vars: { A: "3" }, routes: [{ current: true }],
		})).toEqual({ vars: { A: "3", B: "2" }, routes: [{ current: true }] });
	});

	it("writes a custom-domain profile and clears D1 for KV installs", () => {
		const profile = buildWorkerProfile({
			base: { vars: { EXTRA: "keep" }, d1_databases: [{ binding: "DB" }] },
			accountId: "account", zone: { id: "zone", name: "example.com" },
			workerUrl: "https://auth.example.com/", clientId: "1056068924447412224",
			callbackUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/callback",
			guildIds: ["858089274087309313"], roleSource: "cache", backend: "kv", kvId: "kv-id",
			includeEmail: true, fallbackEmail: "oauth@discord.com",
		});
		expect(profile.account_id).toBe("account");
		expect(profile.routes).toEqual([{ pattern: "auth.example.com", custom_domain: true, zone_id: "zone", previews_enabled: false }]);
		expect(profile.d1_databases).toEqual([]);
		expect(profile.vars.EXTRA).toBe("keep");
		expect(profile.vars.ROLE_GUILD_IDS).toBe('["858089274087309313"]');
	});

	it("rejects a Worker URL outside the selected zone", () => {
		expect(() => buildWorkerProfile({
			base: {}, accountId: "account", zone: { id: "zone", name: "example.com" },
			workerUrl: "https://auth.other.net", clientId: "1056068924447412224",
			callbackUrl: "https://team.cloudflareaccess.com/callback", guildIds: [],
			roleSource: "user", backend: "kv", kvId: "kv-id", includeEmail: false,
			fallbackEmail: "oauth@discord.com",
		})).toThrow(/selected Cloudflare zone/);
	});

	it("redacts secret values without hiding the field names", () => {
		expect(redactSecrets({ config: { client_secret: "hidden", client_id: "public" } })).toEqual({
			config: { client_secret: "[redacted]", client_id: "public" },
		});
	});

	it("uses Discord bot authorization and the required User-Agent", async () => {
		let request: { url: string; headers: HeadersInit } | undefined;
		const roles = await fetchGuildRoles("858089274087309313", "token-never-printed", async (url, options) => {
			request = { url: String(url), headers: options?.headers ?? {} };
			return new Response(JSON.stringify([{ id: "123456789012345678", name: "Access" }]), { status: 200 });
		});
		const headers = new Headers(request?.headers);
		expect(request?.url).toContain("/api/v10/guilds/858089274087309313/roles");
		expect(headers.get("Authorization")).toBe("Bot token-never-printed");
		expect(headers.get("User-Agent")).toMatch(/^DiscordBot \(https:\/\/github\.com\/Aiko-IT-Systems\/cloudflare-discord-oidc-worker, /);
		expect(roles[0].name).toBe("Access");
	});
});
