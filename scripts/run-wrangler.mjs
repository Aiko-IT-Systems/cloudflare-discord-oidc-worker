import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateWorkerConfig } from "./generate-worker-config.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
	console.error("Usage: npm run wrangler -- <command> [...args]");
	process.exit(2);
}

const { generatedPath } = generateWorkerConfig();
const wranglerEntrypoint = fileURLToPath(
	new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const result = spawnSync(
	process.execPath,
	[wranglerEntrypoint, command, "--config", generatedPath, ...args],
	{ stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
