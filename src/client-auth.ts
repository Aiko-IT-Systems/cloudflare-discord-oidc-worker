import { secretsEqual } from "./protocol";

function decodeFormComponent(value: string): string {
	return new URLSearchParams(`credential=${value}`).get("credential") ?? "";
}

export async function validateClient(
	authorization: string | undefined,
	body: Record<string, unknown>,
	env: Env,
	clientId: string,
): Promise<boolean> {
	let id: string;
	let secret: string;
	if (authorization !== undefined) {
		const match = /^Basic\s+(.+)$/i.exec(authorization);
		if (
			!match ||
			Object.hasOwn(body, "client_id") ||
			Object.hasOwn(body, "client_secret")
		)
			return false;
		try {
			const decoded = atob(match[1]);
			const separator = decoded.indexOf(":");
			if (separator <= 0) return false;
			id = decodeFormComponent(decoded.slice(0, separator));
			secret = decodeFormComponent(decoded.slice(separator + 1));
		} catch {
			return false;
		}
	} else {
		id = typeof body.client_id === "string" ? body.client_id : "";
		secret = typeof body.client_secret === "string" ? body.client_secret : "";
	}
	return (
		id === clientId &&
		typeof env.DISCORD_CLIENT_SECRET === "string" &&
		(await secretsEqual(secret, env.DISCORD_CLIENT_SECRET))
	);
}
