import { createHash, randomUUID } from 'node:crypto';
import type { Client, Row, Transaction } from '@libsql/client';
import { isOrganizationId, isWorkspaceId } from './anthropic-identity';
import { CLAUDE_FLEET_SCHEMA } from './schema';

export type FleetJobStatus = 'queued' | 'claimed' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'quarantined';
export type FleetJobPayload = {
  mode: 'read_only';
  alias: string;
  expectedOrganizationId: string;
  workspaceId: string;
  credentialBindingId: string;
  branch: string;
  revision: string;
  prompt: string;
  previousJobId?: string;
  maxBudgetUsd: number;
  timeoutMs: number;
};
export type FleetJob = {
  id: string;
  requestKey: string;
  payload: FleetJobPayload;
  status: FleetJobStatus;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  dispatchStartedAt: number | null;
  sandboxId: string | null;
  sessionId: string | null;
  snapshotId: string | null;
  result: string | null;
  error: FleetJobError | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};
export type FleetJobError = 'identity_unverified' | 'credentials_unavailable' | 'provider_auth_rejected' | 'provider_rate_limited' | 'setup_failed' | 'lease_expired_before_dispatch' | 'execution_uncertain' | 'cancel_uncertain' | 'execution_failed' | 'attempts_exhausted' | 'budget_exhausted';
export type FleetCompletion = {
  sandboxId: string;
  stoppedSandboxId: string;
  sessionId: string;
  snapshotId: string;
  result: string;
};
export type FleetClaimOptions = { maxConcurrency: number; leaseMs: number; maxAttempts?: number };
export type FleetStoreErrorCode = 'invalid_request' | 'request_key_conflict' | 'invalid_continuation' | 'continuation_already_submitted' | 'schema_uninitialized';

export class FleetStoreError extends Error {
  constructor(readonly code: FleetStoreErrorCode) {
    super(code);
    this.name = 'FleetStoreError';
  }
}

const ACTIVE_STATES = "('claimed', 'running', 'cancel_requested', 'quarantined')";
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ERRORS = new Set<FleetJobError>(['identity_unverified', 'credentials_unavailable', 'provider_auth_rejected', 'provider_rate_limited', 'setup_failed', 'lease_expired_before_dispatch', 'execution_uncertain', 'cancel_uncertain', 'execution_failed', 'attempts_exhausted', 'budget_exhausted']);
const normalizeAlias = (alias: string) => alias.toUpperCase().replaceAll('-', '_');
const nullableString = (value: unknown) => value === null || value === undefined ? null : String(value);
const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function decode(row: Row): FleetJob {
  return {
    id: String(row.id), requestKey: String(row.request_key), payload: JSON.parse(String(row.payload_json)) as FleetJobPayload,
    status: String(row.status) as FleetJobStatus, attempts: Number(row.attempts), claimToken: nullableString(row.claim_token),
    leaseExpiresAt: nullableNumber(row.lease_expires_at), dispatchStartedAt: nullableNumber(row.dispatch_started_at),
    sandboxId: nullableString(row.sandbox_id), sessionId: nullableString(row.session_id), snapshotId: nullableString(row.snapshot_id),
    result: nullableString(row.result), error: nullableString(row.error) as FleetJobError | null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), finishedAt: nullableNumber(row.finished_at),
  };
}

function validatePayload(input: FleetJobPayload): FleetJobPayload {
  const allowed = new Set(['mode', 'alias', 'expectedOrganizationId', 'workspaceId', 'credentialBindingId', 'branch', 'revision', 'prompt', 'previousJobId', 'maxBudgetUsd', 'timeoutMs']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key)) ||
      input.mode !== 'read_only' || typeof input.alias !== 'string' || !ALIAS.test(input.alias) ||
      !isOrganizationId(input.expectedOrganizationId) || !isWorkspaceId(input.workspaceId) || typeof input.credentialBindingId !== 'string' || !IDENTIFIER.test(input.credentialBindingId) ||
      typeof input.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,127}$/.test(input.branch) || /\.\.|\/\/|\.lock$|[/.]$/.test(input.branch) ||
      typeof input.revision !== 'string' || !/^[a-f0-9]{40}$/i.test(input.revision) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8_000 ||
      (input.previousJobId !== undefined && (typeof input.previousJobId !== 'string' || !IDENTIFIER.test(input.previousJobId))) ||
      !Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0 || input.maxBudgetUsd > 0.05 ||
      !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 20_000) {
    throw new FleetStoreError('invalid_request');
  }
  // Fixed insertion order gives equivalent requests a stable, secret-free digest.
  return {
    mode: 'read_only', alias: normalizeAlias(input.alias), expectedOrganizationId: input.expectedOrganizationId.toLowerCase(),
    workspaceId: input.workspaceId,
    credentialBindingId: input.credentialBindingId, branch: input.branch, revision: input.revision.toLowerCase(), prompt: input.prompt,
    ...(input.previousJobId ? { previousJobId: input.previousJobId } : {}), maxBudgetUsd: input.maxBudgetUsd, timeoutMs: input.timeoutMs,
  };
}

/** Durable libSQL primary in deployment; local file clients are for explicit setup/tests. */
export class ClaudeFleetStore {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(private readonly client: Client, options: { now?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  /** Call only from a separately authorized initialization script, never request handlers. */
  async initialize(): Promise<void> {
    await this.client.batch([...CLAUDE_FLEET_SCHEMA], 'write');
  }

  private async write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let tx: Transaction | undefined;
      try {
        tx = await this.client.transaction('write');
        const result = await operation(tx);
        await tx.commit();
        return result;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        // SQLITE_BUSY/LOCKED confirms refusal, including COMMIT. Confirm rollback before retrying.
        // Network errors or a lost commit response are uncertain and must never be replayed here.
        if (attempt >= 4 || !/^SQLITE_(BUSY|LOCKED)/.test(code)) throw error;
        if (tx && !tx.closed) await tx.rollback();
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      } finally {
        tx?.close();
      }
    }
  }

  private async readJob(tx: Transaction, id: string): Promise<FleetJob | null> {
    const result = await tx.execute({ sql: 'SELECT * FROM claude_fleet_jobs WHERE id = ?', args: [id] });
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async submit(requestKey: string, input: FleetJobPayload): Promise<{ job: FleetJob; reused: boolean }> {
    if (typeof requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:/.-]{0,255}$/.test(requestKey)) throw new FleetStoreError('invalid_request');
    const payload = validatePayload(input);
    const serialized = JSON.stringify(payload);
    const digest = createHash('sha256').update(serialized).digest('hex');
    return this.write(async (tx) => {
      const prior = await tx.execute({ sql: 'SELECT * FROM claude_fleet_jobs WHERE request_key = ?', args: [requestKey] });
      if (prior.rows[0]) {
        if (String(prior.rows[0].request_digest) !== digest) throw new FleetStoreError('request_key_conflict');
        return { job: decode(prior.rows[0]), reused: true };
      }
      if (payload.previousJobId) {
        const parent = await this.readJob(tx, payload.previousJobId);
        if (!parent || parent.status !== 'succeeded' || !parent.sessionId || !parent.snapshotId ||
            parent.payload.alias !== payload.alias || parent.payload.expectedOrganizationId !== payload.expectedOrganizationId ||
            parent.payload.workspaceId !== payload.workspaceId ||
            parent.payload.credentialBindingId !== payload.credentialBindingId || parent.payload.branch !== payload.branch || parent.payload.revision !== payload.revision) {
          throw new FleetStoreError('invalid_continuation');
        }
        const next = await tx.execute({ sql: 'SELECT id FROM claude_fleet_jobs WHERE previous_job_id = ?', args: [parent.id] });
        if (next.rows.length) throw new FleetStoreError('continuation_already_submitted');
      }
      const id = this.id();
      const now = this.now();
      await tx.execute({ sql: `INSERT INTO claude_fleet_jobs
        (id, request_key, request_digest, payload_json, alias_key, previous_job_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`, args: [id, requestKey, digest, serialized, payload.alias, payload.previousJobId ?? null, now, now] });
      return { job: (await this.readJob(tx, id))!, reused: false };
    });
  }

  async setPaused(paused: boolean): Promise<void> {
    const result = await this.client.execute({ sql: 'UPDATE claude_fleet_settings SET paused = ? WHERE id = 1 AND schema_version = 1', args: [paused ? 1 : 0] });
    if (!result.rowsAffected) throw new FleetStoreError('schema_uninitialized');
  }

  async isPaused(): Promise<boolean> {
    const result = await this.client.execute('SELECT paused FROM claude_fleet_settings WHERE id = 1 AND schema_version = 1');
    if (!result.rows[0]) throw new FleetStoreError('schema_uninitialized');
    return Number(result.rows[0].paused) === 1;
  }

  async claim(options: FleetClaimOptions): Promise<FleetJob | null> {
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 8 ||
        !Number.isInteger(options.leaseMs) || options.leaseMs < 1_000 || options.leaseMs > 600_000 ||
        !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new FleetStoreError('invalid_request');
    return this.write(async (tx) => {
      const now = this.now();
      // A lost worker may still be executing. Preserve its slot until someone proves it stopped.
      await tx.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'quarantined',
        error = CASE WHEN status = 'cancel_requested' THEN 'cancel_uncertain' ELSE 'execution_uncertain' END, updated_at = ?
        WHERE status IN ('claimed', 'running', 'cancel_requested') AND lease_expires_at <= ? AND dispatch_started_at IS NOT NULL`, args: [now, now] });
      await tx.execute({ sql: `UPDATE claude_fleet_jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
        error = CASE WHEN attempts >= ? THEN 'attempts_exhausted' ELSE 'lease_expired_before_dispatch' END,
        claim_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END
        WHERE status = 'claimed' AND lease_expires_at <= ? AND dispatch_started_at IS NULL`, args: [maxAttempts, maxAttempts, now, maxAttempts, now, now] });
      const settings = await tx.execute('SELECT paused FROM claude_fleet_settings WHERE id = 1 AND schema_version = 1');
      if (!settings.rows[0]) throw new FleetStoreError('schema_uninitialized');
      if (Number(settings.rows[0].paused) === 1) return null;
      const active = await tx.execute(`SELECT COUNT(*) AS count FROM claude_fleet_jobs WHERE status IN ${ACTIVE_STATES}`);
      if (Number(active.rows[0].count) >= options.maxConcurrency) return null;
      const queued = await tx.execute({ sql: `SELECT id FROM claude_fleet_jobs pending WHERE status = 'queued' AND attempts < ?
        AND NOT EXISTS (SELECT 1 FROM claude_fleet_jobs active WHERE active.alias_key = pending.alias_key AND active.status IN ${ACTIVE_STATES})
        ORDER BY created_at, id LIMIT 1`, args: [maxAttempts] });
      if (!queued.rows[0]) return null;
      const id = String(queued.rows[0].id);
      await tx.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'claimed', attempts = attempts + 1, claim_token = ?,
        lease_expires_at = ?, updated_at = ?, error = NULL WHERE id = ? AND status = 'queued'`, args: [this.id(), now + options.leaseMs, now, id] });
      return this.readJob(tx, id);
    });
  }

  async markDispatched(jobId: string, claimToken: string, options: { dailyBudgetUsd?: number } = {}): Promise<boolean> {
    const dailyBudgetUsd = options.dailyBudgetUsd ?? 0.25;
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0 || dailyBudgetUsd > 1) throw new FleetStoreError('invalid_request');
    return this.write(async (tx) => {
      // Lock acquisition and confirmed-busy retries may cross a lease or UTC day boundary.
      const current = new Date(this.now());
      const dayStart = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
      const dayEnd = dayStart + 86_400_000;
      // Reservations survive completion/cancellation/quarantine. Billing uncertainty never refunds a cap.
      const spent = await tx.execute({ sql: `SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.maxBudgetUsd') AS REAL)), 0) AS budget
        FROM claude_fleet_jobs WHERE dispatch_started_at >= ? AND dispatch_started_at < ?`, args: [dayStart, dayEnd] });
      const job = await this.readJob(tx, jobId);
      if (!job || Number(spent.rows[0].budget) + job.payload.maxBudgetUsd > dailyBudgetUsd + Number.EPSILON) return false;
      const admittedAt = this.now();
      // A delayed read cannot authorize a different day's budget; leave this claim undispatched.
      if (admittedAt < dayStart || admittedAt >= dayEnd) return false;
      const result = await tx.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'running', dispatch_started_at = ?, updated_at = ?
        WHERE id = ? AND claim_token = ? AND status = 'claimed' AND dispatch_started_at IS NULL AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM claude_fleet_settings WHERE id = 1 AND schema_version = 1 AND paused = 0)`, args: [admittedAt, admittedAt, jobId, claimToken, admittedAt] });
      return result.rowsAffected === 1;
    });
  }

  async attachSandbox(jobId: string, claimToken: string, sandboxId: string): Promise<boolean> {
    if (!IDENTIFIER.test(sandboxId)) throw new FleetStoreError('invalid_request');
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET sandbox_id = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status IN ('running', 'cancel_requested', 'quarantined') AND sandbox_id IS NULL`,
    args: [sandboxId, this.now(), jobId, claimToken] });
    return result.rowsAffected === 1;
  }

  async heartbeat(jobId: string, claimToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) throw new FleetStoreError('invalid_request');
    const now = this.now();
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'running', 'cancel_requested') AND lease_expires_at > ?`, args: [now + leaseMs, now, jobId, claimToken, now] });
    return result.rowsAffected === 1;
  }

  async complete(jobId: string, claimToken: string, evidence: FleetCompletion): Promise<boolean> {
    if (!evidence || !IDENTIFIER.test(evidence.sandboxId) || evidence.stoppedSandboxId !== evidence.sandboxId ||
        !IDENTIFIER.test(evidence.sessionId) || !IDENTIFIER.test(evidence.snapshotId) || typeof evidence.result !== 'string' || evidence.result.length > 64_000) {
      throw new FleetStoreError('invalid_request');
    }
    const now = this.now();
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'succeeded', session_id = ?, snapshot_id = ?,
      result = ?, error = NULL, updated_at = ?, finished_at = ?, lease_expires_at = NULL
      WHERE id = ? AND claim_token = ? AND status = 'running' AND sandbox_id = ? AND lease_expires_at > ?`,
    args: [evidence.sessionId, evidence.snapshotId, evidence.result, now, now, jobId, claimToken, evidence.sandboxId, now] });
    return result.rowsAffected === 1;
  }

  async failBeforeDispatch(jobId: string, claimToken: string, error: FleetJobError, maxAttempts = 3): Promise<boolean> {
    if (!ERRORS.has(error) || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new FleetStoreError('invalid_request');
    const now = this.now();
    const retryable = error === 'setup_failed' || error === 'provider_rate_limited';
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET status = CASE WHEN ? = 1 AND attempts < ? THEN 'queued' ELSE 'failed' END,
      error = ?, claim_token = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = CASE WHEN ? = 1 AND attempts < ? THEN NULL ELSE ? END
      WHERE id = ? AND claim_token = ? AND status = 'claimed' AND dispatch_started_at IS NULL AND lease_expires_at > ?`,
    args: [retryable ? 1 : 0, maxAttempts, error, now, retryable ? 1 : 0, maxAttempts, now, jobId, claimToken, now] });
    return result.rowsAffected === 1;
  }

  async quarantine(jobId: string, claimToken: string, error: FleetJobError = 'execution_uncertain'): Promise<boolean> {
    if (!ERRORS.has(error)) throw new FleetStoreError('invalid_request');
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'quarantined',
      error = CASE WHEN status = 'cancel_requested' THEN 'cancel_uncertain' ELSE ? END, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'running', 'cancel_requested')`, args: [error, this.now(), jobId, claimToken] });
    return result.rowsAffected === 1;
  }

  async requestCancel(jobId: string): Promise<FleetJob | null> {
    return this.write(async (tx) => {
      const job = await this.readJob(tx, jobId);
      if (!job) return null;
      const now = this.now();
      if (job.status === 'queued' || (job.status === 'claimed' && job.dispatchStartedAt === null)) {
        await tx.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'cancelled', updated_at = ?, finished_at = ?, lease_expires_at = NULL, claim_token = NULL WHERE id = ?`, args: [now, now, jobId] });
      } else if (job.status === 'running') {
        await tx.execute({ sql: "UPDATE claude_fleet_jobs SET status = 'cancel_requested', updated_at = ? WHERE id = ?", args: [now, jobId] });
      } else if (job.status === 'quarantined') {
        // Persist intent before attempting an external stop, including when creation lost its response.
        // Keep the uncertain execution slot and all resource evidence until exact stop confirmation.
        await tx.execute({ sql: "UPDATE claude_fleet_jobs SET error = 'cancel_uncertain', updated_at = ? WHERE id = ?", args: [now, jobId] });
      }
      return this.readJob(tx, jobId);
    });
  }

  /** Stop pending work atomically; external work retains its slot until confirmed stopped. */
  async cancelQueued(): Promise<number> {
    const now = this.now();
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'cancelled', updated_at = ?, finished_at = ?,
      claim_token = NULL, lease_expires_at = NULL WHERE status IN ('queued', 'claimed') AND dispatch_started_at IS NULL`, args: [now, now] });
    return result.rowsAffected;
  }

  /** Caller must first confirm the persisted Sandbox has completely stopped. */
  async confirmCancelled(jobId: string, claimToken: string, stoppedSandboxId?: string): Promise<boolean> {
    if (!stoppedSandboxId || !IDENTIFIER.test(stoppedSandboxId)) return false;
    const now = this.now();
    const result = await this.client.execute({ sql: `UPDATE claude_fleet_jobs SET status = 'cancelled', updated_at = ?, finished_at = ?, lease_expires_at = NULL
      WHERE id = ? AND claim_token = ? AND status IN ('cancel_requested', 'quarantined') AND sandbox_id = ?`, args: [now, now, jobId, claimToken, stoppedSandboxId] });
    return result.rowsAffected === 1;
  }

  async get(jobId: string): Promise<FleetJob | null> {
    const result = await this.client.execute({ sql: 'SELECT * FROM claude_fleet_jobs WHERE id = ?', args: [jobId] });
    return result.rows[0] ? decode(result.rows[0]) : null;
  }

  async list(limit = 50): Promise<FleetJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FleetStoreError('invalid_request');
    const result = await this.client.execute({ sql: 'SELECT * FROM claude_fleet_jobs ORDER BY created_at DESC, id DESC LIMIT ?', args: [limit] });
    return result.rows.map(decode);
  }

  async listActive(): Promise<FleetJob[]> {
    const result = await this.client.execute(`SELECT * FROM claude_fleet_jobs WHERE status IN ${ACTIVE_STATES} ORDER BY created_at, id`);
    return result.rows.map(decode);
  }
}
