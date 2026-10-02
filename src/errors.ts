export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly operation: string,
		readonly status: number | null = null,
		readonly retryAfterMs: number | null = null,
		readonly timedOut = false,
		readonly context: Record<string, string | number | boolean | null> = {},
	) {
		super(message);
		this.name = "UpstreamError";
	}
}

export function logError(
	event: string,
	error: unknown,
	context: Record<string, string | number | boolean | null> = {},
): void {
	const details =
		error instanceof UpstreamError
			? {
					errorMessage: error.message.slice(0, 200),
					...error.context,
					errorName: error.name,
					operation: error.operation,
					status: error.status,
					retryAfterMs: error.retryAfterMs,
					timedOut: error.timedOut,
				}
			: {
					errorName: error instanceof Error ? error.name : "UnknownError",
					...(error instanceof Error
						? { errorMessage: error.message.slice(0, 200) }
						: {}),
				};
	console.error(JSON.stringify({ event, ...context, ...details }));
}

export function logWarning(
	event: string,
	context: Record<string, string | number | boolean | null>,
): void {
	console.warn(JSON.stringify({ event, ...context }));
}
