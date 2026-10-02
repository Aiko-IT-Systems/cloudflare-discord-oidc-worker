import { UpstreamError } from "./errors";
import type {
	DiscordGuild,
	DiscordGuildMember,
	DiscordTokenResponse,
	DiscordUser,
} from "./types";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
export const USER_AGENT =
	"Discord OIDC Worker (https://github.com/Aiko-IT-Systems/cloudflare-discord-oidc-worker)";
const INTERACTIVE_TIMEOUT_MS = 10_000;
const INTERACTIVE_RETRY_AFTER_MAX_MS = 3_000;

export function discordHeaders(
	token: string,
	kind: "Bearer" | "Bot",
): HeadersInit {
	return { Authorization: `${kind} ${token}`, "User-Agent": USER_AGENT };
}

interface RequestOptions {
	operation: string;
	deadline?: number;
	maxRateLimitRetries?: number;
	maxRetryAfterMs?: number;
	context?: Record<string, string | number | boolean | null>;
}

async function responseRetryDelay(response: Response): Promise<number | null> {
	const retryAfter = response.headers.get("Retry-After");
	const headerSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	if (Number.isFinite(headerSeconds) && headerSeconds >= 0)
		return headerSeconds * 1000;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as {
		retry_after?: unknown;
	} | null;
	return typeof body?.retry_after === "number" &&
		Number.isFinite(body.retry_after) &&
		body.retry_after >= 0
		? body.retry_after * 1000
		: null;
}

function wait(
	delayMs: number,
	deadline: number | undefined,
	operation: string,
	status: number,
	context: Record<string, string | number | boolean | null>,
): Promise<void> {
	if (deadline !== undefined && Date.now() + delayMs >= deadline)
		throw new UpstreamError(
			"Discord retry exceeds the remaining operation window",
			operation,
			status,
			delayMs,
			true,
			context,
		);
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function requestDiscord(
	url: string,
	init: RequestInit,
	options: RequestOptions,
): Promise<Response> {
	const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
	const maxRetryAfterMs =
		options.maxRetryAfterMs ?? INTERACTIVE_RETRY_AFTER_MAX_MS;
	let rateLimitRetries = 0;
	let serverRetries = 0;
	while (true) {
		if (options.deadline !== undefined && Date.now() >= options.deadline)
			throw new UpstreamError(
				"Discord request exceeded its time budget",
				options.operation,
				null,
				null,
				true,
				options.context,
			);
		const remainingMs =
			options.deadline === undefined
				? INTERACTIVE_TIMEOUT_MS
				: Math.max(1, options.deadline - Date.now());
		let response: Response;
		try {
			response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(
					Math.min(remainingMs, INTERACTIVE_TIMEOUT_MS),
				),
			});
		} catch (error) {
			const timedOut =
				Date.now() >= (options.deadline ?? Date.now() + remainingMs);
			throw new UpstreamError(
				timedOut
					? "Discord request exceeded its time budget"
					: "Discord request failed",
				options.operation,
				null,
				null,
				timedOut || (error instanceof Error && error.name === "TimeoutError"),
				options.context,
			);
		}
		if (response.status === 429) {
			const retryAfterMs = await responseRetryDelay(response);
			if (
				retryAfterMs === null ||
				rateLimitRetries >= maxRateLimitRetries ||
				retryAfterMs > maxRetryAfterMs
			) {
				throw new UpstreamError(
					"Discord rate limit cannot be retried within the operation policy",
					options.operation,
					429,
					retryAfterMs,
					false,
					options.context,
				);
			}
			await wait(
				retryAfterMs,
				options.deadline,
				options.operation,
				429,
				options.context ?? {},
			);
			rateLimitRetries += 1;
			continue;
		}
		if (response.status >= 500 && serverRetries < 1) {
			const retryAfterMs = (await responseRetryDelay(response)) ?? 500;
			if (retryAfterMs > maxRetryAfterMs)
				throw new UpstreamError(
					"Discord service retry exceeds the operation policy",
					options.operation,
					response.status,
					retryAfterMs,
					false,
					options.context,
				);
			await wait(
				retryAfterMs,
				options.deadline,
				options.operation,
				response.status,
				options.context ?? {},
			);
			serverRetries += 1;
			continue;
		}
		return response;
	}
}

export function requireDiscordOk(
	response: Response,
	operation: string,
	context: Record<string, string | number | boolean | null> = {},
): void {
	if (!response.ok)
		throw new UpstreamError(
			"Discord returned an error",
			operation,
			response.status,
			null,
			false,
			context,
		);
}

export async function discordOAuthErrorCode(
	response: Response,
): Promise<string | null> {
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as {
		error?: unknown;
	} | null;
	return typeof body?.error === "string" ? body.error : null;
}

export async function readDiscordJson<T>(
	response: Response,
	operation: string,
	parse: (value: unknown) => T,
	context: Record<string, string | number | boolean | null> = {},
): Promise<T> {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new UpstreamError(
			"Discord returned invalid JSON",
			operation,
			response.status,
			null,
			false,
			context,
		);
	}
	try {
		return parse(value);
	} catch {
		throw new UpstreamError(
			"Discord returned an unexpected response",
			operation,
			response.status,
			null,
			false,
			context,
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDiscordToken(value: unknown): DiscordTokenResponse {
	if (
		!isRecord(value) ||
		typeof value.access_token !== "string" ||
		value.access_token.length === 0 ||
		typeof value.token_type !== "string" ||
		value.token_type.toLowerCase() !== "bearer" ||
		typeof value.expires_in !== "number" ||
		!Number.isFinite(value.expires_in) ||
		typeof value.scope !== "string"
	)
		throw new Error("Invalid token response");
	return value as unknown as DiscordTokenResponse;
}

export function parseDiscordUser(value: unknown): DiscordUser {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.username !== "string" ||
		value.username.length === 0 ||
		(value.global_name !== undefined &&
			value.global_name !== null &&
			typeof value.global_name !== "string") ||
		(value.avatar !== undefined &&
			value.avatar !== null &&
			typeof value.avatar !== "string") ||
		(value.email !== undefined &&
			value.email !== null &&
			typeof value.email !== "string") ||
		(value.verified !== undefined && typeof value.verified !== "boolean")
	)
		throw new Error("Invalid user response");
	return value as unknown as DiscordUser;
}

export function parseDiscordGuilds(value: unknown): DiscordGuild[] {
	if (
		!Array.isArray(value) ||
		value.some((guild) => !isRecord(guild) || typeof guild.id !== "string")
	)
		throw new Error("Invalid guild list");
	return value as DiscordGuild[];
}

export function parseDiscordMember(value: unknown): DiscordGuildMember {
	if (
		!isRecord(value) ||
		(value.user !== undefined &&
			(!isRecord(value.user) ||
				typeof value.user.id !== "string" ||
				value.user.id.length === 0)) ||
		!Array.isArray(value.roles) ||
		value.roles.some((role) => typeof role !== "string")
	)
		throw new Error("Invalid member response");
	return value as unknown as DiscordGuildMember;
}

export function parseDiscordMemberPage(value: unknown): DiscordGuildMember[] {
	if (!Array.isArray(value)) throw new Error("Invalid member page");
	const members = value.map(parseDiscordMember);
	if (members.some((member) => !member.user?.id))
		throw new Error("Member page omitted a user ID");
	return members;
}
