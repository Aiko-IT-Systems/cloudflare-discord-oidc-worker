import app from "./app";
import { logError } from "./errors";
import { cacheRoles } from "./role-cache";

const worker: ExportedHandler<Env> = {
	fetch(request, env, ctx) {
		return app.fetch(request, env, ctx);
	},
	async scheduled(_controller, env) {
		try {
			await cacheRoles(env);
		} catch (error) {
			logError("role_snapshot_refresh_failed", error);
			throw error;
		}
	},
};

export default worker;
