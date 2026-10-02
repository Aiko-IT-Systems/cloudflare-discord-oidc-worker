import * as jose from "jose";
import { parseJsonArray } from "./config";
import type { OidcJwk } from "./types";

export const ID_TOKEN_TTL_SECONDS = 300;
export const PENDING_AUTH_TTL_SECONDS = 600;

export function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export async function sha256Base64Url(value: string): Promise<string> {
	return base64Url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
}

export function validateCodeVerifier(value: string): boolean {
	return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export async function secretsEqual(
	left: string,
	right: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	const leftBytes = new Uint8Array(leftHash);
	const rightBytes = new Uint8Array(rightHash);
	let difference = 0;
	for (let index = 0; index < leftBytes.length; index += 1)
		difference |= leftBytes[index] ^ rightBytes[index];
	return difference === 0;
}

export function pendingNonceKey(challenge: string): string {
	return `oidc:pending:${challenge}`;
}

export async function loadSigningKey(
	env: Env,
): Promise<{ key: CryptoKey; kid: string; jwks: OidcJwk[] }> {
	if (!env.OIDC_SIGNING_PRIVATE_JWK) {
		throw new Error("OIDC_SIGNING_PRIVATE_JWK secret is required");
	}
	const privateJwk = JSON.parse(env.OIDC_SIGNING_PRIVATE_JWK) as JsonWebKey & {
		kid?: string;
	};
	if (
		privateJwk.kty !== "RSA" ||
		!privateJwk.kid ||
		!privateJwk.n ||
		!privateJwk.e ||
		!privateJwk.d
	) {
		throw new Error(
			"Signing JWK must be an RSA private key with kid and public components",
		);
	}
	const key = (await jose.importJWK(privateJwk, "RS256")) as CryptoKey;
	const activePublicKey: OidcJwk = {
		kty: privateJwk.kty,
		n: privateJwk.n,
		e: privateJwk.e,
		alg: "RS256",
		use: "sig",
		kid: privateJwk.kid,
	};
	const retiringKeys = parseJsonArray(
		env.OIDC_RETIRING_PUBLIC_KEYS ?? "[]",
		"OIDC_RETIRING_PUBLIC_KEYS",
	).map((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(
				"Retiring keys must be public RS256 RSA JWKs with kid, n, and e",
			);
		const jwk = value as Record<string, unknown>;
		if (
			jwk.kty !== "RSA" ||
			typeof jwk.kid !== "string" ||
			typeof jwk.n !== "string" ||
			typeof jwk.e !== "string" ||
			jwk.alg !== "RS256"
		) {
			throw new Error(
				"Retiring keys must be public RS256 RSA JWKs with kid, n, and e",
			);
		}
		if (
			["d", "p", "q", "dp", "dq", "qi", "oth"].some((field) => field in jwk)
		) {
			throw new Error(
				"Private keys must never be configured as retiring JWKS entries",
			);
		}
		return {
			kty: "RSA",
			kid: jwk.kid,
			n: jwk.n,
			e: jwk.e,
			alg: "RS256",
			use: "sig",
		} as OidcJwk;
	});
	if (
		new Set([privateJwk.kid, ...retiringKeys.map((jwk) => jwk.kid)]).size !==
		retiringKeys.length + 1
	) {
		throw new Error("Signing key IDs must be unique");
	}
	return { key, kid: privateJwk.kid, jwks: [activePublicKey, ...retiringKeys] };
}
