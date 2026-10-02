import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const canonicalRepository = "aiko-it-systems/cloudflare-discord-oidc-worker";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const templatePath = resolve(root, "wrangler.jsonc");
const userPath = resolve(root, "wrangler.user.jsonc");
const aitsysPath = resolve(root, "wrangler.aitsys.jsonc");
const generatedDirectory = resolve(root, ".wrangler");
const generatedPath = resolve(root, "wrangler.generated.jsonc");
const redirectPath = resolve(generatedDirectory, "deploy/config.json");

function stripJsonComments(source) {
	let result = "";
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let index = 0; index < source.length; index += 1) {
		const current = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (current === "\n") {
				lineComment = false;
				result += current;
			}
			continue;
		}
		if (blockComment) {
			if (current === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			result += current;
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === '"') inString = false;
			continue;
		}
		if (current === '"') {
			inString = true;
			result += current;
		} else if (current === "/" && next === "/") {
			lineComment = true;
			index += 1;
		} else if (current === "/" && next === "*") {
			blockComment = true;
			index += 1;
		} else {
			result += current;
		}
	}
	return result.replace(/,\s*([}\]])/g, "$1");
}

function readConfig(path) {
	const value = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
	if (!value || Array.isArray(value) || typeof value !== "object")
		throw new Error(`${path} must contain a JSON object.`);
	return value;
}

function mergeConfig(base, override) {
	const output = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			output[key] &&
			typeof output[key] === "object" &&
			!Array.isArray(output[key])
		) {
			output[key] = mergeConfig(output[key], value);
		} else {
			output[key] = value;
		}
	}
	return output;
}

function normalizeGitHubRepository(remoteUrl) {
	if (!remoteUrl) return undefined;
	const value = remoteUrl.trim();
	const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
	const https = value.match(
		/^(?:https?|ssh):\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
	);
	return (ssh?.[1] ?? https?.[1])?.toLowerCase();
}

function getOriginRemote() {
	try {
		return execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

export function selectProfile({ userConfig, aitsysConfig, remoteUrl }) {
	if (Object.keys(userConfig).length > 0)
		return { name: "user", config: userConfig };
	if (normalizeGitHubRepository(remoteUrl) === canonicalRepository)
		return { name: "aitsys", config: aitsysConfig };
	return { name: "template", config: {} };
}

export function generateWorkerConfig({
	remoteUrl = getOriginRemote(),
} = {}) {
	const template = readConfig(templatePath);
	const userConfig = readConfig(userPath);
	const aitsysConfig = readConfig(aitsysPath);
	const profile = selectProfile({ userConfig, aitsysConfig, remoteUrl });
	const config = mergeConfig(template, profile.config);

	mkdirSync(dirname(generatedPath), { recursive: true });
	writeFileSync(generatedPath, `${JSON.stringify(config, null, "\t")}\n`);
	mkdirSync(dirname(redirectPath), { recursive: true });
	writeFileSync(
		redirectPath,
		`${JSON.stringify({ configPath: relative(dirname(redirectPath), generatedPath).replaceAll("\\", "/") }, null, "\t")}\n`,
	);
	console.log(`Generated Wrangler config using the ${profile.name} profile.`);
	return { config, profile: profile.name, generatedPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	generateWorkerConfig();
