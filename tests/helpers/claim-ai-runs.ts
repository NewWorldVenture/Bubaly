import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InMemorySupabase, Row } from './in-memory-supabase';

/**
 * `claim_ai_runs`, predicate for predicate, against the in-memory client.
 *
 * The real function is SQL (0250, rewritten by 0263 and again by the migration
 * `claimAiRunsMigration()` finds), and its behavioural proofs are the SQL
 * probes under docs/audit. This is the stand-in a test registers as
 * `rpc: { claim_ai_runs }` so the real cron route, `continueRun`, `claimRun`
 * and `releaseRun` can be driven end to end. It writes the RUN ROW only; the
 * four-table reconcile of a dead-lettered run (steps, request ledger, timeline)
 * is the probes' to prove.
 *
 * The recovery statement has two arms sharing one `failed` outcome:
 *   - an `executing` run whose lease is NOT NULL and in the past: back to
 *     `ready`, or `failed` once `attempt >= max_attempts`;
 *   - a run parked in the queue (`ready` / `scheduled_followup`) with no live
 *     lease, no cancel in flight and `attempt >= max_attempts`: `failed`.
 * The candidates are then the due, unleased, uncancelled queue rows BELOW the
 * ceiling, oldest `run_after` first, each claimed with a fresh lease and one
 * more attempt.
 */
export const ABANDONED = 'Run abandoned after the maximum number of attempts.';

export function claimAiRuns(args: Record<string, unknown>, db: InMemorySupabase): string[] {
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10), 50));
  const leaseSeconds = Math.max(30, Math.min(Number(args.p_lease_seconds ?? 120), 900));
  const now = Date.now();
  const rows = db.table('family_automation_runs') as Array<Row & { id: string }>;

  const leaseLive = (r: Row) => r.lease_expires_at != null && Date.parse(String(r.lease_expires_at)) >= now;
  const leaseExpired = (r: Row) => r.state === 'executing' && r.lease_expires_at != null && Date.parse(String(r.lease_expires_at)) < now;
  const inQueue = (r: Row) => r.state === 'ready' || r.state === 'scheduled_followup';
  const atCeiling = (r: Row) => Number(r.attempt) >= Number(r.max_attempts);
  const spentInQueue = (r: Row) => inQueue(r) && atCeiling(r) && !leaseLive(r) && r.cancel_requested_at == null;

  for (const r of rows) {
    if (!leaseExpired(r) && !spentInQueue(r)) continue;
    const dead = atCeiling(r);
    Object.assign(r, {
      state: dead ? 'failed' : 'ready',
      status: dead ? 'failed' : r.status,
      error: dead ? (r.error ?? ABANDONED) : r.error,
      completed_at: dead ? new Date(now).toISOString() : r.completed_at,
      lease_owner: null, lease_expires_at: null, run_after: new Date(now).toISOString(),
    });
  }

  const candidates = rows
    .filter((r) => inQueue(r)
      && Date.parse(String(r.run_after)) <= now
      && !leaseLive(r)
      && r.cancel_requested_at == null
      && !atCeiling(r))
    .sort((a, b) => String(a.run_after).localeCompare(String(b.run_after)))
    .slice(0, limit);
  for (const r of candidates) {
    Object.assign(r, {
      state: 'executing', attempt: Number(r.attempt) + 1, lease_owner: randomUUID(),
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(), started_at: r.started_at ?? new Date(now).toISOString(),
    });
  }
  return candidates.map((r) => r.id);
}

const SLUG = '_a_run_with_no_attempts_left_is_abandoned_not_reclaimed.sql';

/**
 * The migration that currently defines `claim_ai_runs`, found by its name
 * rather than its number: numbers are reserved by the audit coordinator and a
 * file can be renumbered when branches land, and a test that pins the body
 * should not break on that.
 */
export function claimAiRunsMigration(root = join(__dirname, '..', '..')): { path: string; sql: string } {
  const dir = join(root, 'supabase', 'migrations');
  const file = readdirSync(dir).find((f) => f.endsWith(SLUG));
  if (!file) throw new Error(`no migration named *${SLUG} under ${dir}`);
  return { path: join('supabase', 'migrations', file), sql: readFileSync(join(dir, file), 'utf8') };
}
