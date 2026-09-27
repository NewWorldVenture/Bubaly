// m7r1 — A "no" is final, and so is every other decision.
//
// 0381 put the family's approval model into the database, and gated the
// TRANSITION INTO a decision: a vote is the voter's own, approved/modified
// needs the yeses the row's model asks for, the rule columns are frozen. It
// gated nothing after that. `approval_requests_decide` (0251:135-137) is
// `can_manage_family` on USING and WITH CHECK with no status predicate and no
// column pin, so on a row one parent DECLINED any manager could, with the
// browser session and one PATCH over /rest/v1:
//
//   - set status back to 'pending' and approvals to [] — rule A permits taking
//     votes away, rule B does not run for a move to pending — and the request
//     is asked again as if nobody had said no;
//   - on a 'single' row, set status 'approved' with their own yes — A passes
//     (one vote, their own), B passes (one manager satisfies 'single') — and
//     reconcileApprovals releases the gated step with skipTrust;
//   - move an approved row to rejected after the work ran, un-expire a row
//     nobody answered, or rewrite `edited_payload` on a decided plan-step row,
//     which is what the executor runs.
//
// The application never does any of this: `openForDecision` refuses a decision
// on a non-pending row with "This request was already decided." and every
// status writer (`flipStatus`, the expiry sweep, run cancellation) predicates on
// `status = 'pending'`. 0389 makes the database say the same.
//
// The live proof is docs/audit/two-parents-means-two-parents-check.sql, run in
// CI against a replayed Postgres. The cases here are the source half: they pin
// the design choices the probe cannot see from outside (what is frozen, for
// whom, and what still lands), they keep the probe from losing its negative
// control without a red test, and they pin the application's own refusal so a
// change on either side is visible.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const executed = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[] }));
const db = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => db.client,
  createServiceClient: () => db.client,
}));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, args: unknown) => {
    executed.calls.push({ name, args });
    return { status: 'ok', data: { id: 'ev-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { decide, editAndApprove } = await import('@/lib/services/approvals');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const DAD = '33333333-3333-4333-8333-333333333333';
const APPROVAL = '66666666-6666-4666-8666-666666666666';

let store: InMemorySupabase;

function scopeAs(member: string, user: string): ServiceScope {
  return {
    db: store as unknown as SupabaseClient<Database>,
    familyId: FAMILY, userId: user, memberId: member, role: 'parent', actorKind: 'member', tz: 'America/New_York',
  };
}

function approvalRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: APPROVAL, family_id: FAMILY, domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'Concierge', title: 'Add soccer Saturday', summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool', amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier',
    approval_model: 'single', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z', executed_at: null,
    execution_result: null, request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], evidence: null, edited_payload: null, reviewed_by: null, review_note: null,
    ...over,
  };
}

beforeEach(() => {
  executed.calls = [];
  store = createInMemorySupabase();
  db.client = store;
  store.seed('family_members', [
    { id: MUM, family_id: FAMILY, user_id: 'auth-mum', display_name: 'Mum', role: 'parent', is_active: true },
    { id: DAD, family_id: FAMILY, user_id: 'auth-dad', display_name: 'Dad', role: 'parent', is_active: true },
  ]);
});

describe('the application treats a decision as terminal', () => {
  it('will not approve, decline or edit a request one parent already declined — and runs nothing', async () => {
    store.seed('approval_requests', [approvalRow({
      status: 'rejected', decided_by: MUM, decided_at: '2026-09-05T11:00:00Z',
      approvals: [{ member_id: MUM, decision: 'rejected', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }],
    })]);

    const approve = await decide(scopeAs(DAD, 'auth-dad'), APPROVAL, 'approved');
    const decline = await decide(scopeAs(DAD, 'auth-dad'), APPROVAL, 'rejected');
    const edit = await editAndApprove(scopeAs(DAD, 'auth-dad'), APPROVAL, { title: 'Soccer — later' });

    for (const res of [approve, decline, edit]) {
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toBe('This request was already decided.');
    }
    expect(executed.calls).toEqual([]);
    const row = store.table('approval_requests')[0];
    expect(row.status).toBe('rejected');
    expect(row.decided_by).toBe(MUM);
    expect(row.approvals).toHaveLength(1);
  });

  it('will not re-decide an approved request either', async () => {
    store.seed('approval_requests', [approvalRow({
      status: 'approved', decided_by: MUM, decided_at: '2026-09-05T11:00:00Z',
      approvals: [{ member_id: MUM, decision: 'approved', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }],
    })]);

    const res = await decide(scopeAs(DAD, 'auth-dad'), APPROVAL, 'rejected');

    expect(res.ok).toBe(false);
    expect(store.table('approval_requests')[0].status).toBe('approved');
    expect(executed.calls).toEqual([]);
  });
});

// The rule above lives in a server action, and `approval_requests` is reachable
// with the signed-in browser session. What makes a "no" final for a PATCH is
// 0389, and what proves 0389 is the probe. These cases read the SQL for the
// exact rule and the probe for its negative control.
describe('the database keeps a decision, not only the action (0389)', () => {
  const file = (() => {
    const names = readdirSync('supabase/migrations').filter((f) => /_a_decision_once_made_stays_made\.sql$/.test(f));
    expect(names.length, 'the 0389 decision-is-final migration must exist').toBe(1);
    return { name: names[0], sql: readFileSync(`supabase/migrations/${names[0]}`, 'utf8') };
  })();
  // Comments stripped: the header discusses policies and roles in prose.
  const statements = file.sql.replace(/--[^\n]*/g, '');
  const PROBE = 'docs/audit/two-parents-means-two-parents-check.sql';

  it('is numbered in the range this tranche was given and never edits 0381', () => {
    expect(file.name).toMatch(/^038[89]_|^0390_/);
    // 0381's rules are left exactly as written: no create-or-replace of its
    // functions, no drop of its triggers.
    expect(statements).not.toMatch(/function public\.approval_decision_is_earned\(\)\s*\n?\s*returns/);
    expect(statements).not.toMatch(/function public\.approval_rule_is_immutable\(\)\s*\n?\s*returns/);
    expect(statements).not.toContain('drop trigger if exists approval_requests_decision_is_earned');
    expect(statements).not.toContain('drop trigger if exists approval_requests_rule_is_immutable');
  });

  it('freezes a decided row on the columns that ARE the decision, in a BEFORE UPDATE trigger', () => {
    expect(statements).toContain('create trigger approval_requests_decision_is_final');
    expect(statements).toMatch(/before update on public\.approval_requests\s+for each row execute function public\.approval_decision_is_final\(\)/);
    expect(statements).toContain("if old.status is distinct from 'pending' then");
    expect(statements).toContain('if new.status is distinct from old.status then');
    expect(statements).toContain('if new.approvals is distinct from old.approvals');
    expect(statements).toContain('or new.edited_payload is distinct from old.edited_payload');
    expect(statements).toContain('or new.decided_by is distinct from old.decided_by');
    expect(statements).toContain('or new.decided_at is distinct from old.decided_at');
    // A refusal, not a silent no-op — and the same class PostgREST gives a
    // policy refusal, so the client sees 403 either way.
    expect(statements).toMatch(/raise exception[\s\S]*using errcode = '42501'/);
  });

  it('does NOT freeze the execution stamp — stampExecution writes to a decided row and must still land', () => {
    expect(statements).not.toMatch(/new\.executed_at/);
    expect(statements).not.toMatch(/new\.execution_result/);
    expect(statements).not.toMatch(/new\.consequences/);
    expect(statements).not.toMatch(/new\.request_id/);
  });

  it('freezes the ask itself for the life of the row', () => {
    expect(statements).toContain('if new.payload is distinct from old.payload then');
  });

  it('applies to the callers row-level security applies to, so the expiry sweep and run cancellation are not newly refused', () => {
    expect(statements).toContain('select r.rolsuper or r.rolbypassrls into v_bypass');
    expect(statements).toContain('if coalesce(v_bypass, false) then');
  });

  it('changes no policy and removes nothing', () => {
    expect(statements).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
    expect(statements).not.toMatch(/\bdrop\s+(table|column|function)\b/i);
    expect(statements).toContain('drop trigger if exists approval_requests_decision_is_final on public.approval_requests;');
    expect(statements).toMatch(/create or replace function public\.approval_decision_is_final/);
    expect(statements).toContain('revoke all on function public.approval_decision_is_final() from public, anon, authenticated;');
  });

  it('is proven live by the two-parents probe, with a negative control that drops ONLY this trigger', () => {
    expect(existsSync(PROBE)).toBe(true);
    const probe = readFileSync(PROBE, 'utf8');
    // The refusal cases.
    expect(probe).toContain('re-opened a DECLINED two-parent row');
    expect(probe).toContain('moved a DECLINED single-approver row to approved with one PATCH');
    expect(probe).toContain('moved an APPROVED row to rejected');
    expect(probe).toContain('rewrote edited_payload on an APPROVED row');
    expect(probe).toContain('rewrote payload on a PENDING row');
    // The control that must LAND.
    expect(probe).toContain('stampExecution could not stamp a DECLINED row');
    // The negative control, attributed to this trigger and this trigger only:
    // 0381's decision trigger is dropped LATER in the file, so at this point it
    // is still in force and the flip that lands is the one 0381 alone permitted.
    const mine = probe.indexOf('drop trigger if exists approval_requests_decision_is_final on public.approval_requests;');
    const theirs = probe.indexOf('drop trigger if exists approval_requests_decision_is_earned on public.approval_requests;');
    expect(mine).toBeGreaterThan(-1);
    expect(theirs).toBeGreaterThan(mine);
    expect(probe).toContain("with 0389''s trigger removed the adult''s rejected->approved flip touched");
  });
});
