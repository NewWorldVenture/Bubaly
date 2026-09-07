// The shared contract for the domain service layer.
//
// Why this exists: a household write currently happens in three places that
// each re-derive tenancy, actor identity and error copy on their own — UI
// server actions (`app/(app)/dashboard/**/actions.ts`), the AI toolbox
// (`lib/assistant/tools.ts`, `lib/ai/actions.ts`) and crons
// (`lib/server/notifications.ts`, `lib/autopilot/scan.ts`). Those forks have
// already diverged in ways users can see: the toolbox writes an auth user id
// into `todo_lists.created_by`, which references `family_members(id)`, so the
// AI's to-do list creation fails a foreign key the UI path satisfies. A single
// service layer removes the class of bug rather than the instance.
//
// `ServiceResult` deliberately mirrors the `ActionResult` shape already used by
// `lib/family/actions.ts` so UI callers need no second convention, and error
// copy comes from `describeDbError`/`describeActionError`
// (`lib/supabase/errors.ts`). Services never throw for an expected database
// failure — a thrown error in a server action becomes an opaque digest in
// production, which is exactly the observability we are trying to gain.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MemberRole } from '@/lib/constants/roles';

/**
 * Who is asking. `member` = a signed-in human acting through the UI, `ai` = a
 * tool call the assistant made on someone's behalf, `system` = a cron or the
 * run executor with no human in the loop. Services branch on this for the
 * activity feed (which records agent work, not manual edits) and for audit.
 */
export type ActorKind = 'member' | 'ai' | 'system';

export type ServiceScope = {
  /**
   * The caller's RLS-bound client, or the service client for cron/executor
   * work. Because both shapes flow through here, every service filters
   * `family_id` explicitly instead of trusting RLS to scope the query.
   */
  db: SupabaseClient<Database>;
  familyId: string;
  /** auth.users id; null for cron/system actors with no human behind them. */
  userId: string | null;
  /** `family_members.id` of the acting member; null for cron/system. */
  memberId: string | null;
  role: MemberRole | 'system';
  actorKind: ActorKind;
  /** IANA timezone of the family, e.g. 'America/New_York'. Never the server's. */
  tz: string;
  /** Injectable clock so behaviour around dates is testable without faking time globally. */
  now?: Date;
  runId?: string | null;
  stepId?: string | null;
  requestId?: string | null;
  /**
   * When set, a retry of the same logical operation must not create a second
   * row. See `lib/services/idempotency.ts` for how services honour it.
   */
  idempotencyKey?: string | null;
  /** Private executor-issued reserved-operation identity and existing ledger client, not caller input. */
  toolOperation?: { id: string; db: SupabaseClient<Database> };
};

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; retryable?: boolean };

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

/**
 * `error` is the message a human reads, so callers pass the output of
 * `describeDbError`/`describeActionError` rather than a raw Postgres string.
 * `code` is for machines (the tool executor decides whether to surface a retry
 * affordance); `retryable` marks transient transport failures.
 */
export function fail(error: string, opts?: { code?: string; retryable?: boolean }): ServiceResult<never> {
  return { ok: false, error, ...(opts?.code ? { code: opts.code } : {}), ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}) };
}

/** Stable `code` values services emit, so callers can branch without string matching. */
export const SERVICE_CODES = {
  invalidInput: 'invalid_input',
  notFound: 'not_found',
  denied: 'denied',
  db: 'db',
} as const;
