CREATE TABLE IF NOT EXISTS role_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    roles_json TEXT NOT NULL,
    PRIMARY KEY (
        guild_id,
        snapshot_id,
        user_id
    )
);

CREATE INDEX IF NOT EXISTS role_members_lookup ON role_members (
    guild_id,
    snapshot_id,
    user_id
);

CREATE TABLE IF NOT EXISTS active_role_snapshots (
    guild_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);