// `approval_model` used to be a label. The Trust UI offered "Two-parent", the
// row stored it, and `decide` read only `required_approvals` — which the same
// form defaulted to 1 and stored independently. So a policy a family created
// specifically because one adult should not be able to authorise it alone was
// satisfied by exactly that. And when a two-approval row DID hold, the first
// approver's edits were recorded on `edited_payload` and then thrown away: the
// deciding vote executed the original.
//
// These tests are about both: what a model requires and from whom, and that
// what runs is what the family agreed to.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { thresholdFor, describeThreshold } from '@/lib/approvals/threshold';
import { toApprovalCardData, type TrustApproval } from '@/lib/approvals/card-data';

const executed = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[] }));
const holder = vi.hoisted(() => ({ service: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!holder.service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return holder.service;
  },
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

type Row = Record<string, unknown> & { id: string };

/**
 * A PostgREST fake that also answers `select(cols, { count, head })` — the
 * consensus threshold is a count of managers, so a store that silently returns
 * no count would make every consensus assertion pass for the wrong reason.
 */
function makeStore(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let kind: 'select' | 'insert' | 'update' = 'select';
    let payload: unknown;
    let wantCount = false;
    const b: Record<string, unknown> = {};
    const matches = (row: Row) => Object.entries(filters).every(([key, value]) => (
      key.startsWith('in:') ? (value as unknown[]).includes(row[key.slice(3)]) : row[key] === value
    ));
    const resolve = () => {
      const rows = tables[table] ?? (tables[table] = []);
      if (kind === 'insert') {
        const inserted = (Array.isArray(payload) ? payload : [payload]) as Row[];
        rows.push(...inserted.map((p) => ({ ...p, id: p.id ?? `${table}-${rows.length + 1}` })));
        return { data: inserted[0] ?? null, error: null, count: null };
      }
      if (kind === 'update') {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, payload as Record<string, unknown>);
        return { data: hit, error: null, count: hit.length };
      }
      const hit = rows.filter(matches);
      return { data: wantCount ? null : hit, error: null, count: hit.length };
    };
    const filter = (c: string, v: unknown) => { filters[c] = v; return b; };
    Object.assign(b, {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => { wantCount = Boolean(opts?.head); return b; },
      order: () => b, limit: () => b, or: () => b,
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      lt: () => b, gt: () => b, filter: () => b,
      insert: (p: unknown) => { kind = 'insert'; payload = p; return b; },
      update: (p: unknown) => { kind = 'update'; payload = p; return b; },
      single: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      maybeSingle: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      then: (ok: (v: { data: unknown; error: null; count: number | null }) => void) => ok(resolve()),
    });
    return b;
  };
  const db = { from } as unknown as SupabaseClient<Database>;
  // Server-side writers (the run ledger, the audit trail) reach for the service
  // client; in this harness it is the same in-memory store.
  holder.service = db;
  return { db, tables };
}

const NOW = new Date('2026-09-05T12:00:00Z');
const MEMBERS: Row[] = [
  { id: 'mum', family_id: 'fam-1', display_name: 'Mum', role: 'parent', is_active: true },
  { id: 'dad', family_id: 'fam-1', display_name: 'Dad', role: 'parent', is_active: true },
  { id: 'nan', family_id: 'fam-1', display_name: 'Nan', role: 'adult', is_active: true },
];

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

function approvalRow(over: Partial<Row> = {}): Row {
  return {
    id: 'appr-1', family_id: 'fam-1', domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'concierge', title: 'Add soccer Saturday', summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool', amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier',
    approval_model: 'single', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2026-09-07T12:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], consequences: [], evidence: null,
    edited_payload: null, reviewed_by: null, review_note: null,
    created_at: '2026-09-05T10:00:00Z', updated_at: '2026-09-05T10:00:00Z',
    ...over,
  };
}

beforeEach(() => { executed.calls = []; holder.service = null; });

describe('thresholdFor — the model is the rule', () => {
  it('two parents means two, and means parents', () => {
    expect(thresholdFor('two_parent', 1, 4)).toEqual({ required: 2, parentsOnly: true });
  });

  it('consensus means everyone who could approve', () => {
    expect(thresholdFor('consensus', 1, 3)).toEqual({ required: 3, parentsOnly: false });
    // A one-manager household still has a reachable threshold.
    expect(thresholdFor('consensus', 1, 0)).toEqual({ required: 1, parentsOnly: false });
  });

  it('a stored count may raise a model’s floor and never lower it', () => {
    expect(thresholdFor('two_parent', 3, 4).required).toBe(3);
    expect(thresholdFor('two_parent', 1, 4).required).toBe(2);
    expect(thresholdFor('single', 2, 4)).toEqual({ required: 2, parentsOnly: false });
  });

  it('keeps the retired spellings working as plain counts', () => {
    for (const model of ['first_available', 'sequential', null, undefined, 'nonsense']) {
      expect(thresholdFor(model, 1, 4)).toEqual({ required: 1, parentsOnly: false });
    }
  });

  it('says what it is waiting for, and says nothing when there is nothing to say', () => {
    expect(describeThreshold({ required: 2, parentsOnly: true }, 1)).toBe('Needs 2 parents — 1 recorded');
    expect(describeThreshold({ required: 1, parentsOnly: false }, 0)).toBe('');
  });
});

describe('decide — a two-parent request needs two parents', () => {
  const row = () => approvalRow({ approval_model: 'two_parent', required_approvals: 1 });

  it('refuses an adult’s approval rather than counting it', async () => {
    const store = makeStore({ approval_requests: [row()], family_members: MEMBERS });
    const res = await decide(scopeWith(store.db, { memberId: 'nan', role: 'adult' }), 'appr-1', 'approved');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/two parents/i);
    expect(executed.calls).toEqual([]);
    expect(store.tables.approval_requests[0].status).toBe('pending');
  });

  it('holds after one parent, and runs on the second — even though the row said required_approvals: 1', async () => {
    const store = makeStore({ approval_requests: [row()], family_members: MEMBERS });
    const first = await decide(scopeWith(store.db, { memberId: 'mum', role: 'parent' }), 'appr-1', 'approved');
    expect(first).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    expect(first.ok === true && first.data.summary).toMatch(/1 more parent needs to approve/);
    expect(executed.calls).toEqual([]);

    const second = await decide(scopeWith(store.db, { memberId: 'dad', role: 'parent' }), 'appr-1', 'approved');
    expect(second).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].name).toBe('calendar.createEvent');
  });

  it('still lets one "no" stop it, from anyone who can decide', async () => {
    const store = makeStore({ approval_requests: [row()], family_members: MEMBERS });
    const res = await decide(scopeWith(store.db, { memberId: 'nan', role: 'adult' }), 'appr-1', 'rejected');
    expect(res).toMatchObject({ ok: true, data: { status: 'rejected' } });
    expect(executed.calls).toEqual([]);
  });
});

describe('decide — consensus counts the household', () => {
  it('waits for every parent and adult', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ approval_model: 'consensus', required_approvals: 1 })],
      family_members: MEMBERS,
    });
    const a = await decide(scopeWith(store.db, { memberId: 'mum' }), 'appr-1', 'approved');
    expect(a.ok === true && a.data.summary).toMatch(/2 more people need to approve/);
    await decide(scopeWith(store.db, { memberId: 'dad' }), 'appr-1', 'approved');
    expect(executed.calls).toEqual([]);
    const c = await decide(scopeWith(store.db, { memberId: 'nan', role: 'adult' }), 'appr-1', 'approved');
    expect(c).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(executed.calls).toHaveLength(1);
  });
});

describe('decide — the deciding vote runs what the family agreed to', () => {
  it('executes the first approver’s edit, not the original', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ approval_model: 'two_parent', required_approvals: 1 })],
      family_members: MEMBERS,
    });
    const edited = await editAndApprove(scopeWith(store.db, { memberId: 'mum' }), 'appr-1', { title: 'Soccer — bring boots' });
    expect(edited).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(store.tables.approval_requests[0].edited_payload).toMatchObject({ title: 'Soccer — bring boots' });

    await decide(scopeWith(store.db, { memberId: 'dad' }), 'appr-1', 'approved');
    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toMatchObject({ title: 'Soccer — bring boots' });
  });

  it('ignores a stored payload that changes a field the card never offered', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({
        approval_model: 'two_parent',
        required_approvals: 1,
        approvals: [{ member_id: 'mum', decision: 'approved', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }],
        // Written straight to the column rather than through editAndApprove.
        edited_payload: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', family_id: 'someone-elses' },
      })],
      family_members: MEMBERS,
    });
    await decide(scopeWith(store.db, { memberId: 'dad' }), 'appr-1', 'approved');
    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).not.toHaveProperty('family_id');
  });
});

describe('the card says what it is waiting for', () => {
  const card = (over: Partial<TrustApproval>) => toApprovalCardData(
    { ...(approvalRow() as unknown as TrustApproval), ...over },
    { requestedBy: null, canEdit: true, managerCount: 3 },
  );

  it('reports the model’s threshold, not the stored count', () => {
    const data = card({ approval_model: 'two_parent', required_approvals: 1 });
    expect(data).toMatchObject({ requiredApprovals: 2, approvalsRecorded: 0, parentsOnly: true });
  });

  it('counts only the approvals that count', () => {
    const data = card({
      approval_model: 'two_parent',
      required_approvals: 1,
      approvals: [
        { member_id: 'nan', decision: 'approved', note: null, at: '', role: 'adult' },
        { member_id: 'mum', decision: 'approved', note: null, at: '', role: 'parent' },
      ],
    });
    expect(data.approvalsRecorded).toBe(1);
  });

  it('leaves a single-approver request looking exactly as it did', () => {
    expect(card({})).toMatchObject({ requiredApprovals: 1, approvalsRecorded: 0, parentsOnly: false });
  });
});
