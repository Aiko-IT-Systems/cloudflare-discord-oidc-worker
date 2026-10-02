interface Env {
	/** Optional bot token used for bot role lookups and scheduled cache refreshes. */
	DISCORD_TOKEN?: string;
	/** Local-only switch for loopback HTTP redirects in the integration harness. */
	ALLOW_LOCAL_HTTP_REDIRECTS?: string;
}
