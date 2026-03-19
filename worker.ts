import configData from './config.json'
import { Hono } from 'hono'
import * as jose from 'jose'

interface AppConfig {
	clientId: string
	clientSecret: string
	redirectUrls: string[]
	serversToCheckRolesFor?: string[]
	cacheRoles: boolean
	includeEmail?: boolean
	fallbackEmail?: string
}

interface StoredKeyPair {
	publicKey: JsonWebKey
	privateKey: JsonWebKey
}

interface DiscordTokenSuccessResponse {
	access_token: string
	token_type: string
	expires_in: number
	refresh_token?: string
	scope: string
}

interface DiscordErrorResponse {
	error?: string
	error_description?: string
	message?: string
}

interface DiscordUser {
	id: string
	email?: string | null
	verified?: boolean
	[key: string]: unknown
}

interface DiscordGuildSummary {
	id: string
	[key: string]: unknown
}

interface DiscordGuildMember {
	roles?: string[]
	user?: {
		id?: string
	}
	[key: string]: unknown
}

type RoleCacheRecord = Record<string, string[]>
type RoleClaims = Record<`roles:${string}`, string[]>
type ScopeMode = 'identify' | 'email' | 'guilds' | 'roles'
type AppEnv = {
	Bindings: Env
}

const config: AppConfig = configData
const app = new Hono<AppEnv>()

const SIGNING_ALGORITHM: RsaHashedKeyGenParams = {
	name: 'RSASSA-PKCS1-v1_5',
	modulusLength: 2048,
	publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
	hash: { name: 'SHA-256' },
}

const IMPORT_ALGORITHM: RsaHashedImportParams = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: { name: 'SHA-256' },
}

const DISCORD_USER_AGENT =
	'DiscordBot (https://github.com/Aiko-IT-Systems/cloudflare-discord-oidc-worker, v4.0.0)'

function isScopeMode(value: string): value is ScopeMode {
	return value === 'identify' || value === 'email' || value === 'guilds' || value === 'roles'
}

function shouldIncludeEmail(): boolean {
	return config.includeEmail ?? true
}

function getFallbackEmail(): string {
	return config.fallbackEmail ?? 'oauth@discord.com'
}

function getScopesForMode(mode: ScopeMode): string {
	const scopes = ['identify']

	if (shouldIncludeEmail()) {
		scopes.push('email')
	}

	switch (mode) {
		case 'identify':
		case 'email':
			return scopes.join(' ')
		case 'guilds':
			scopes.push('guilds')
			return scopes.join(' ')
		case 'roles':
			scopes.push('guilds', 'guilds.members.read')
			return scopes.join(' ')
	}
}

function getConfiguredGuildIds(): string[] {
	return Array.isArray(config.serversToCheckRolesFor) ? config.serversToCheckRolesFor : []
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
	return 'publicKey' in value && 'privateKey' in value
}

function getStringValue(
	value: FormDataEntryValue | File | string | null | undefined,
): string | null {
	if (typeof value === 'string' && value.length > 0) {
		return value
	}

	return null
}

function getDiscordHeaders(token: string, kind: 'Bearer' | 'Bot'): HeadersInit {
	return {
		Authorization: `${kind} ${token}`,
		'User-Agent': DISCORD_USER_AGENT,
	}
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T
}

function logDiscordError(prefix: string, payload: DiscordErrorResponse | null): void {
	if (!payload) {
		console.error(prefix)
		return
	}

	console.error(prefix, {
		error: payload.error,
		error_description: payload.error_description,
		message: payload.message,
	})
}

async function loadOrGenerateKeyPair(kv: KVNamespace): Promise<CryptoKeyPair> {
	const storedKeyPair = await kv.get<StoredKeyPair>('keys', 'json')

	if (storedKeyPair) {
		return {
			publicKey: await crypto.subtle.importKey(
				'jwk',
				storedKeyPair.publicKey,
				IMPORT_ALGORITHM,
				true,
				['verify'],
			),
			privateKey: await crypto.subtle.importKey(
				'jwk',
				storedKeyPair.privateKey,
				IMPORT_ALGORITHM,
				true,
				['sign'],
			),
		}
	}

	const generatedKeys = await crypto.subtle.generateKey(
		SIGNING_ALGORITHM,
		true,
		['sign', 'verify'],
	)

	if (!isCryptoKeyPair(generatedKeys)) {
		throw new Error('Expected crypto.subtle.generateKey() to return a CryptoKeyPair')
	}

	await kv.put(
		'keys',
		JSON.stringify({
			privateKey: await crypto.subtle.exportKey('jwk', generatedKeys.privateKey),
			publicKey: await crypto.subtle.exportKey('jwk', generatedKeys.publicKey),
		} satisfies StoredKeyPair),
	)

	return generatedKeys
}

async function getRolesFromCacheFor(
	env: Env,
	guildId: string,
	memberId: string,
): Promise<string[] | null> {
	const memberRoleCache = await env.KV.get<RoleCacheRecord>(`roles:${guildId}`, 'json')

	if (memberRoleCache && memberId in memberRoleCache) {
		return memberRoleCache[memberId] ?? null
	}

	return null
}

function getRetryDelayMs(response: Response): number {
	const retryAfterHeader = response.headers.get('Retry-After')

	if (!retryAfterHeader) {
		return 10_000
	}

	const retryAfterSeconds = Number(retryAfterHeader)
	return Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 10_000
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchGuildMemberPage(
	env: Env,
	guildId: string,
	after?: string,
): Promise<DiscordGuildMember[]> {
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const params = new URLSearchParams({ limit: '1000' })
		if (after) {
			params.set('after', after)
		}

		const response = await fetch(
			`https://discord.com/api/guilds/${guildId}/members?${params.toString()}`,
			{
				headers: getDiscordHeaders(env.DISCORD_TOKEN ?? '', 'Bot'),
			},
		)

		if (response.ok) {
			return readJson<DiscordGuildMember[]>(response)
		}

		if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
			const delayMs = getRetryDelayMs(response)
			console.log(`Guild member fetch for ${guildId} hit ${response.status}, retrying in ${delayMs}ms`)
			await sleep(delayMs)
			continue
		}

		const errorPayload = await readJson<DiscordErrorResponse | null>(response).catch(() => null)
		logDiscordError(`Failed to fetch guild members for ${guildId}`, errorPayload)
		throw new Error(`Discord guild member fetch failed with status ${response.status}`)
	}

	throw new Error(`Discord guild member fetch failed for ${guildId}`)
}

async function cacheRoles(_controller: ScheduledController, env: Env): Promise<void> {
	console.log('Triggered cacheRoles')

	if (!config.cacheRoles || !env.DISCORD_TOKEN || getConfiguredGuildIds().length === 0) {
		console.log('Skipping cacheRoles')
		return
	}

	console.log('Executing cacheRoles')
	const memberRoleCache: Record<string, RoleCacheRecord> = {}

	await Promise.all(
		getConfiguredGuildIds().map(async (guildId) => {
			const tempMemberList: DiscordGuildMember[] = []
			let lastMemberId: string | undefined

			while (true) {
				const members = await fetchGuildMemberPage(env, guildId, lastMemberId)
				console.log(`Got ${members.length} members for ${guildId}`)

				if (members.length === 0) {
					break
				}

				tempMemberList.push(...members)
				lastMemberId = members.at(-1)?.user?.id

				if (!lastMemberId) {
					throw new Error(`Received malformed member payload while caching roles for ${guildId}`)
				}
			}

			const guildRoleCache: RoleCacheRecord = {}
			for (const member of tempMemberList) {
				const memberId = member.user?.id
				if (!memberId) {
					continue
				}

				guildRoleCache[memberId] = Array.isArray(member.roles) ? member.roles : []
			}

			memberRoleCache[guildId] = guildRoleCache
			await env.KV.put(`roles:${guildId}`, JSON.stringify(guildRoleCache), {
				expirationTtl: 3600,
			})
			console.log(`Cached roles for ${Object.keys(guildRoleCache).length} members in ${guildId}`)
		}),
	)

	console.log(`Cached roles for ${Object.keys(memberRoleCache).length} servers`)
}

app.get('/authorize/:scopemode', async (c) => {
	const clientId = c.req.query('client_id')
	const redirectUri = c.req.query('redirect_uri')
	const scopeModeParam = c.req.param('scopemode')

	if (
		clientId !== config.clientId ||
		!redirectUri ||
		!config.redirectUrls.includes(redirectUri) ||
		!isScopeMode(scopeModeParam)
	) {
		return c.text('Bad request.', 400)
	}

	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: getScopesForMode(scopeModeParam),
		state: c.req.query('state') ?? '',
		prompt: 'none',
	})

	return c.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`)
})

app.post('/token', async (c) => {
	const body = await c.req.parseBody()
	const code = getStringValue(body.code)
	const redirectUri = getStringValue(body.redirect_uri)

	if (!code || !redirectUri || !config.redirectUrls.includes(redirectUri)) {
		return c.text('Bad request.', 400)
	}

	const tokenParams = new URLSearchParams({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		redirect_uri: redirectUri,
		code,
		grant_type: 'authorization_code',
	})

	const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
		method: 'POST',
		body: tokenParams.toString(),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': DISCORD_USER_AGENT,
		},
	})

	if (!tokenResponse.ok) {
		const errorPayload = await readJson<DiscordErrorResponse | null>(tokenResponse).catch(() => null)
		logDiscordError('Discord token exchange failed', errorPayload)
		return c.text('Bad request.', 400)
	}

	const tokenData = await readJson<DiscordTokenSuccessResponse>(tokenResponse)
	const returnedScopes = new Set(tokenData.scope.split(' ').filter(Boolean))

	const userInfoResponse = await fetch('https://discord.com/api/users/@me', {
		headers: getDiscordHeaders(tokenData.access_token, 'Bearer'),
	})

	if (!userInfoResponse.ok) {
		const errorPayload = await readJson<DiscordErrorResponse | null>(userInfoResponse).catch(() => null)
		logDiscordError('Discord user fetch failed', errorPayload)
		return c.text('Bad request.', 400)
	}

	const userInfo = await readJson<DiscordUser>(userInfoResponse)

	if (shouldIncludeEmail() && !userInfo.verified) {
		console.error('User is not verified')
		return c.text('Bad request.', 400)
	}

	let guildIds: string[] = []

	if (returnedScopes.has('guilds')) {
		const guildResponse = await fetch('https://discord.com/api/users/@me/guilds', {
			headers: getDiscordHeaders(tokenData.access_token, 'Bearer'),
		})

		if (guildResponse.ok) {
			const guilds = await readJson<DiscordGuildSummary[]>(guildResponse)
			guildIds = guilds.map((guild) => guild.id)
		}
	}

	const roleClaims: RoleClaims = {}
	const configuredGuildIds = getConfiguredGuildIds()

	if (config.cacheRoles) {
		await Promise.all(
			configuredGuildIds.map(async (guildId) => {
				const roleCache = await getRolesFromCacheFor(c.env, guildId, userInfo.id)
				if (roleCache) {
					roleClaims[`roles:${guildId}`] = roleCache
				}
			}),
		)
	} else if (returnedScopes.has('guilds.members.read')) {
		await Promise.all(
			configuredGuildIds.map(async (guildId) => {
				if (!guildIds.includes(guildId)) {
					return
				}

				const memberResponse = await fetch(
					`https://discord.com/api/users/@me/guilds/${guildId}/member`,
					{
						headers: getDiscordHeaders(tokenData.access_token, 'Bearer'),
					},
				)

				if (!memberResponse.ok) {
					return
				}

				const member = await readJson<DiscordGuildMember>(memberResponse)
				roleClaims[`roles:${guildId}`] = Array.isArray(member.roles) ? member.roles : []
			}),
		)
	} else if (c.env.DISCORD_TOKEN) {
		const botToken = c.env.DISCORD_TOKEN

		await Promise.all(
			configuredGuildIds.map(async (guildId) => {
				if (!guildIds.includes(guildId)) {
					return
				}

				const memberResponse = await fetch(
					`https://discord.com/api/guilds/${guildId}/members/${userInfo.id}`,
					{
						headers: getDiscordHeaders(botToken, 'Bot'),
					},
				)

				if (!memberResponse.ok) {
					return
				}

				const member = await readJson<DiscordGuildMember>(memberResponse)
				roleClaims[`roles:${guildId}`] = Array.isArray(member.roles) ? member.roles : []
			}),
		)
	}

	const idTokenPayload: jose.JWTPayload & Record<string, unknown> = {
		iss: 'https://cloudflare.com',
		aud: config.clientId,
		...userInfo,
		...roleClaims,
		email: shouldIncludeEmail() ? (userInfo.email ?? undefined) : getFallbackEmail(),
		guilds: guildIds,
	}

	const signingKeys = await loadOrGenerateKeyPair(c.env.KV)
	const idToken = await new jose.SignJWT(idTokenPayload)
		.setProtectedHeader({ alg: 'RS256' })
		.setExpirationTime('1h')
		.setAudience(config.clientId)
		.sign(signingKeys.privateKey)

	return c.json({
		...tokenData,
		scope: tokenData.scope,
		id_token: idToken,
	})
})

app.get('/jwks.json', async (c) => {
	const publicKey = (await loadOrGenerateKeyPair(c.env.KV)).publicKey

	return c.json({
		keys: [
			{
				alg: 'RS256',
				kid: 'jwtRS256',
				...(await crypto.subtle.exportKey('jwk', publicKey)),
			},
		],
	})
})

const worker: ExportedHandler<Env> = {
	async fetch(request, env, ctx) {
		return app.fetch(request, env, ctx)
	},
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(cacheRoles(controller, env))
	},
}

export default worker
