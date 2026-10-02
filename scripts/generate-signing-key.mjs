import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const directory = new URL("../.secrets/", import.meta.url);
const privateKeyPath = new URL(
	"../.secrets/oidc-signing-private-jwk.json",
	import.meta.url,
);
const kid = randomUUID();
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicExponent: 0x10001,
});
const privateJwk = {
	...privateKey.export({ format: "jwk" }),
	alg: "RS256",
	use: "sig",
	kid,
};
const publicJwk = {
	...publicKey.export({ format: "jwk" }),
	alg: "RS256",
	use: "sig",
	kid,
};

await mkdir(directory, { recursive: true });
await writeFile(privateKeyPath, `${JSON.stringify(privateJwk)}\n`, {
	mode: 0o600,
});
console.log(`Private signing JWK saved to ${privateKeyPath.pathname}`);
console.log("Set it as secret without printing it:");
console.log(
	"  Get-Content -Raw .secrets/oidc-signing-private-jwk.json | npx wrangler secret put OIDC_SIGNING_PRIVATE_JWK",
);
console.log(
	"Public JWK (safe to publish in OIDC_RETIRING_PUBLIC_KEYS during rotation):",
);
console.log(JSON.stringify(publicJwk));
