import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-level ratchet for the AI runtime schema (0250) and the trust/approval
// hardening (0251). The migrations themselves are proven behaviourally on a
// PGlite (Postgres 18 WASM) harness at authoring time — full ordered set applied
// twice, claim_ai_runs never double-claiming, a teen session blocked from step
// injection / audit forgery / self-approval. What that proof cannot do is stop a
// later edit from quietly reopening a hole, so this test pins the invariants that
// have no unit-testable runtime: which tables have RLS on, which tables must
// carry NO authenticated write policy, the §30 duplicate-guard index, the
// definer/search_path shape of the claim RPC, and the additive-only rule.
//
// Resolved by filename suffix so a renumber (scripts/ci-dedupe-migration-versions)
// does not break the guard.
function migration(suffix: string): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith(suffix));
  expect(files.length, `${suffix} migration must exist exactly once`).toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

const runtime = migration('_ai_runtime_core.sql');
const hardening = migration('_ai_trust_hardening.sql');
const types = readFileSync('lib/database.types.ts', 'utf8');

// Tables the executor writes with the service client. A member INSERT/UPDATE on
// any of these is step injection or audit forgery (0250 header), so they must
// carry a SELECT policy and nothing else.
const LEDGERS = ['ai_plans', 'ai_plan_steps', 'ai_run_events', 'ai_tool_calls', 'ai_request_context'];
const NEW_TABLES = ['ai_requests', ...LEDGERS];

describe('0250 AI runtime core schema', () => {
  it('creates every table the entity map specifies', () => {
    for (const table of NEW_TABLES) {
      expect(runtime, `${table} must be created`).toContain(`create table if not exists public.${table} (`);
    }
  });

  it('scopes every new table to a family with a cascading FK', () => {
    for (const table of NEW_TABLES) {
      const body = runtime.slice(
        runtime.indexOf(`create table if not exists public.${table} (`),
        runtime.indexOf(');', runtime.indexOf(`create table if not exists public.${table} (`)),
      );
      expect(body, `${table} must be family-scoped`).toMatch(
        /family_id\s+uuid not null references public\.families\(id\) on delete cascade/,
      );
    }
  });

  it('enables RLS on every new table', () => {
    for (const table of NEW_TABLES) {
      expect(runtime).toContain(`alter table public.${table} enable row level security;`);
    }
  });

  it('gives members SELECT on the family-readable tables', () => {
    for (const table of ['ai_requests', 'ai_plans', 'ai_plan_steps', 'ai_run_events']) {
      expect(runtime).toMatch(
        new RegExp(`create policy ${table}_select on public\\.${table}\\s+for select to authenticated using \\(public\\.is_family_member\\(family_id\\)\\)`),
      );
    }
  });

  it('narrows the two tables that can leak another member’s data', () => {
    // Tool-call inputs/outputs and the raw context slice can hold finance rows,
    // document text or another member's medical detail.
    expect(runtime).toMatch(/create policy ai_tool_calls_select[\s\S]*requested_by = auth\.uid\(\) or public\.can_manage_family\(family_id\)/);
    expect(runtime).toMatch(/create policy ai_request_context_select[\s\S]*public\.can_manage_family\(family_id\)/);
    expect(runtime).toMatch(/create policy ai_request_context_select[\s\S]*r\.requested_by = auth\.uid\(\)/);
  });

  it('grants NO authenticated write policy on the executor-written ledgers', () => {
    const offenders: string[] = [];
    for (const table of LEDGERS) {
      for (const cmd of ['insert', 'update', 'delete', 'all']) {
        // `for insert to authenticated` etc. anywhere in a policy on this table.
        const re = new RegExp(`create policy [\\w"]+ on public\\.${table}\\s+for ${cmd}\\b`, 'i');
        if (re.test(runtime)) offenders.push(`${table}: for ${cmd}`);
      }
    }
    expect(offenders, `service-client-only ledgers must not accept member writes:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('lets a member file their own request and nothing more', () => {
    expect(runtime).toMatch(
      /create policy ai_requests_insert on public\.ai_requests\s+for insert to authenticated\s+with check \(public\.is_family_member\(family_id\) and requested_by = auth\.uid\(\)\)/,
    );
    expect(runtime).not.toMatch(/create policy ai_requests_update/);
    expect(runtime).not.toMatch(/create policy ai_requests_delete/);
  });

  it('keeps the §30 duplicate guard: one idempotency key per family', () => {
    expect(runtime).toMatch(
      /create unique index if not exists uq_ai_tool_calls_idempotency\s+on public\.ai_tool_calls \(family_id, idempotency_key\) where idempotency_key is not null;/,
    );
  });

  it('indexes the real query paths', () => {
    for (const index of [
      'idx_ai_requests_family_created on public.ai_requests (family_id, created_at desc)',
      'idx_ai_run_events_run on public.ai_run_events (run_id, created_at)',
      'idx_ai_plan_steps_plan_status on public.ai_plan_steps (plan_id, status)',
      'uq_ai_plan_steps_plan_sequence on public.ai_plan_steps (plan_id, sequence)',
      'idx_ai_tool_calls_run on public.ai_tool_calls (run_id)',
      'uq_family_automation_runs_idempotency\n  on public.family_automation_runs (family_id, idempotency_key)',
      'idx_family_automation_runs_claim',
    ]) {
      expect(runtime, `missing index: ${index}`).toContain(index);
    }
  });

  it('extends family_automation_runs without disturbing its legacy status column', () => {
    for (const column of [
      'request_id', 'plan_id', 'run_type', 'state', 'started_at', 'completed_at', 'error',
      'cancel_requested_at', 'paused_at', 'run_after', 'lease_owner', 'lease_expires_at',
      'attempt', 'idempotency_key',
    ]) {
      expect(runtime, `family_automation_runs.${column} must be added`).toContain(`add column if not exists ${column}`);
    }
    // The 0022 free-text column keeps working: no CHECK, no rewrite, no default change.
    expect(runtime).not.toMatch(/alter column status/);
    expect(runtime).not.toMatch(/family_automation_runs_status_check/);
    // …and the legacy → §10 display mapping is written down where the next
    // reader of this table will look for it.
    expect(runtime).toMatch(/pending\s+→ awaiting_approval/);
    expect(runtime).toMatch(/executed\s+→ completed/);
  });

  it('extends the conversation tables the concierge reads', () => {
    for (const column of ['state', 'prompt_version']) {
      expect(runtime).toContain(`add column if not exists ${column}`);
    }
    for (const column of ['structured_content', 'model', 'usage', 'request_id', 'sender_member_id']) {
      const scope = runtime.slice(runtime.indexOf('alter table public.ai_messages'));
      expect(scope, `ai_messages.${column} must be added`).toContain(`add column if not exists ${column}`);
    }
  });

  it('publishes the tables the run UI subscribes to', () => {
    const scope = runtime.slice(runtime.indexOf('-- ─── Realtime'));
    expect(scope).toContain("array['ai_run_events','ai_plan_steps','family_automation_runs']");
    // Idempotent add, in the 0240 style — a second apply must not error.
    expect(scope).toContain('from pg_publication_tables');
  });
});

describe('claim_ai_runs (executor lease)', () => {
  const fn = runtime.slice(runtime.indexOf('create or replace function public.claim_ai_runs'));

  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(fn).toMatch(/language plpgsql security definer set search_path = public/);
  });

  it('is executable by the service role only', () => {
    expect(runtime).toContain('revoke all on function public.claim_ai_runs(integer, integer) from public;');
    expect(runtime).toContain('grant execute on function public.claim_ai_runs(integer, integer) to service_role;');
    expect(runtime).not.toMatch(/grant execute on function public\.claim_ai_runs\([^)]*\) to authenticated/);
  });

  it('claims atomically so two cron invocations cannot take the same run', () => {
    expect(fn).toContain('for update skip locked');
    expect(fn).toMatch(/state in \('ready','scheduled_followup'\)/);
    expect(fn).toContain('run_after <= now()');
    expect(fn).toMatch(/lease_expires_at is null or lease_expires_at < now\(\)/);
  });

  it('recovers only abandoned executing runs, and dead-letters at max_attempts', () => {
    expect(fn).toMatch(/where state = 'executing'[\s\S]*lease_expires_at < now\(\)/);
    expect(fn).toMatch(/case when attempt >= max_attempts then 'failed' else 'ready' end/);
    // Human-blocked states are never auto-recovered.
    for (const state of ['awaiting_approval', 'paused', 'blocked']) {
      expect(fn, `${state} must not be recovered`).not.toContain(`'${state}'`);
    }
  });

  it('never hands out a run whose cancellation was requested', () => {
    expect(fn).toContain('cancel_requested_at is null');
  });
});

describe('0251 trust / approval hardening', () => {
  it('adds the approval columns the executor needs to pause and resume', () => {
    for (const column of [
      'request_id', 'run_id', 'plan_step_id', 'plan_step_ids', 'consequences',
      'evidence', 'edited_payload', 'payload_kind', 'reviewed_by', 'review_note',
    ]) {
      expect(hardening, `approval_requests.${column} must be added`).toContain(`add column if not exists ${column}`);
    }
    expect(hardening).toContain("check (payload_kind is null or payload_kind in ('tool','plan_steps','concierge_plan'))");
  });

  it('gives approvals a real 48h deadline instead of a NULL that never expires', () => {
    expect(hardening).toContain("alter column expires_at set default (now() + interval '48 hours')");
    expect(hardening).toMatch(/update public\.approval_requests[\s\S]*where expires_at is null and status = 'pending';/);
  });

  it('restricts approval decisions to managers, with a requester-only self-cancel', () => {
    expect(hardening).toMatch(/create policy approval_requests_decide on public\.approval_requests\s+for update to authenticated\s+using \(public\.can_manage_family\(family_id\)\)/);
    const cancel = hardening.slice(hardening.indexOf('create policy approval_requests_cancel_own'));
    expect(cancel).toContain("status = 'pending'");
    expect(cancel).toContain("status = 'cancelled'");
    expect(cancel).toContain('fm.user_id = auth.uid()');
    // The member INSERT stays (a child must be able to ask) — DECISIONS.md.
    expect(hardening).toMatch(/create policy approval_requests_insert on public\.approval_requests\s+for insert to authenticated with check \(public\.is_family_member\(family_id\)\)/);
    expect(hardening).not.toMatch(/create policy approval_requests_delete/);
  });

  it('locks family_automation_runs and parent_approvals UPDATE/DELETE to managers', () => {
    for (const table of ['family_automation_runs', 'parent_approvals']) {
      expect(hardening).toMatch(new RegExp(`create policy ${table}_update on public\\.${table}\\s+for update to authenticated\\s+using \\(public\\.can_manage_family\\(family_id\\)\\)`));
      expect(hardening).toMatch(new RegExp(`create policy ${table}_delete on public\\.${table}\\s+for delete to authenticated using \\(public\\.can_manage_family\\(family_id\\)\\)`));
      // …while SELECT + INSERT stay with the whole family: a member files a run
      // by accepting a plan, and a child files a wallet approval request.
      expect(hardening).toContain(`create policy ${table}_select on public.${table}`);
      expect(hardening).toContain(`create policy ${table}_insert on public.${table}`);
      // The permissive FOR ALL policies these replace must be dropped first.
      expect(hardening).toMatch(new RegExp(`drop policy if exists "[^"]+" on public\\.${table};`));
    }
  });

  it('widens the trust audit vocabulary for policy/grant/delegation/role changes', () => {
    for (const decision of ['policy_changed', 'grant_changed', 'delegation_changed', 'role_changed', 'modified']) {
      expect(hardening).toContain(`'${decision}'`);
    }
    expect(hardening).toContain('validate constraint trust_audit_logs_decision_check');
  });
});

describe('both migrations stay additive and idempotent', () => {
  for (const [name, sql] of [['0250', runtime], ['0251', hardening]] as const) {
    it(`${name} drops no table, column or type`, () => {
      const stripped = sql.replace(/--[^\n]*/g, '');
      expect(stripped).not.toMatch(/\bdrop\s+table\b/i);
      expect(stripped).not.toMatch(/\bdrop\s+column\b/i);
      expect(stripped).not.toMatch(/\btruncate\b/i);
      expect(stripped).not.toMatch(/\bdrop\s+type\b/i);
    });

    it(`${name} guards every create so a re-apply is a no-op`, () => {
      const creates = [...sql.matchAll(/create (table|index|unique index|policy|trigger)([^\n;]*)/gi)];
      expect(creates.length).toBeGreaterThan(5);
      const unguarded = creates
        .map((m) => `${m[1]}${m[2]}`)
        .filter((line) => {
          if (/if not exists/i.test(line)) return false;
          // Policies and triggers are guarded by a preceding `drop ... if exists`.
          if (/^policy/i.test(line)) {
            const policyName = line.replace(/^policy\s+/i, '').split(/\s+on\s+/)[0].trim();
            return !new RegExp(`drop policy if exists ${policyName.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')} on`, 'i').test(sql);
          }
          if (/^trigger/i.test(line)) return !/drop trigger if exists/i.test(sql);
          return true;
        });
      expect(unguarded, `unguarded creates in ${name}:\n${unguarded.join('\n')}`).toEqual([]);
    });

    it(`${name} guards every added constraint against a second apply`, () => {
      const constraints = [...sql.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]);
      expect(constraints.length).toBeGreaterThan(0);
      for (const c of constraints) {
        const at = sql.indexOf(`add constraint ${c}`);
        const after = sql.slice(at, at + 900);
        const before = sql.slice(Math.max(0, at - 400), at);
        const guarded = /exception when duplicate_object/i.test(after)
          || new RegExp(`drop constraint if exists ${c}`, 'i').test(before);
        expect(guarded, `${name}: constraint ${c} is not re-apply safe`).toBe(true);
      }
    });
  }
});

describe('lib/database.types.ts tracks the new schema', () => {
  it('declares every new table', () => {
    for (const table of ['ai_requests', 'ai_request_context', 'ai_plans', 'ai_plan_steps', 'ai_run_events', 'ai_tool_calls']) {
      expect(types, `${table} must be typed`).toContain(`      ${table}: T<`);
    }
  });

  it('declares the new run columns and the claim RPC', () => {
    const runs = types.slice(types.indexOf('      family_automation_runs: T<'));
    for (const column of ['state:', 'run_after:', 'lease_owner:', 'lease_expires_at:', 'attempt:', 'idempotency_key:']) {
      expect(runs.slice(0, 4000), `family_automation_runs.${column} must be typed`).toContain(column);
    }
    expect(types).toContain('claim_ai_runs: { Args: { p_limit?: number; p_lease_seconds?: number }; Returns: string[] };');
  });

  it('declares the new approval columns', () => {
    const approvals = types.slice(types.indexOf('      approval_requests: T<'));
    for (const column of ['run_id:', 'plan_step_ids:', 'consequences:', 'edited_payload:', 'payload_kind:']) {
      expect(approvals.slice(0, 4000), `approval_requests.${column} must be typed`).toContain(column);
    }
  });
});
