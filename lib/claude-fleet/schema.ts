/** Explicit setup only. Runtime routes must never create or migrate the database. */
export const CLAUDE_FLEET_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS claude_fleet_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1))
  )`,
  `INSERT OR IGNORE INTO claude_fleet_settings (id, schema_version, paused) VALUES (1, 1, 1)`,
  `CREATE TABLE IF NOT EXISTS claude_fleet_jobs (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    previous_job_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'quarantined')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claim_token TEXT,
    lease_expires_at INTEGER,
    dispatch_started_at INTEGER,
    sandbox_id TEXT,
    session_id TEXT,
    snapshot_id TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS claude_fleet_alias_slot ON claude_fleet_jobs (alias_key)
    WHERE status IN ('claimed', 'running', 'cancel_requested', 'quarantined')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS claude_fleet_one_continuation ON claude_fleet_jobs (previous_job_id)
    WHERE previous_job_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS claude_fleet_pending ON claude_fleet_jobs (status, created_at, id)`,
] as const;
