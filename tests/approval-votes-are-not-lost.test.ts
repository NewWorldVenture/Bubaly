// A two-parent approval collects its votes in a JSONB array on the row, and
// each vote is appended with a read-modify-write:
//
//   const prior = priorVotes(row);
//   const votes = [...prior, { member_id: memberId, … }];
//   flipStatus(scope, approvalId, { approvals: votes, … });
//
// `flipStatus` is predicated on `status = 'pending'`, which is what stops two
// DECIDING votes from both executing. But a non-deciding vote does not change
// the status, so that predicate matches for both of two parents who click
// Approve at the same moment — and the second write replaces the array the
// first one wrote. One parent's vote is silently gone.
//
// It fails safe: an under-count can never approve something that should not be.
// What it costs is the feature. Both parents are told "your approval is
// recorded"; the request stays pending forever, and the audit trail — the thing
// a family would look at to understand why — has no record that the lost vote
// happened.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const holder = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async () => ({ status: 'ok', data: { id: 'ev-1' }, summary: 'done', toolCallId: 'call-1', verified: true }),
}));

const { decide } = await import('@/lib/services/approvals');

type Row = Record<string, unknown> & { id: string };

/**
 * A PostgREST fake whose reads and writes can be interleaved on purpose.
 *
 * `gate` is awaited between a builder resolving its filters and applying them,
 * which is where the real race lives: both callers read, then both write.
 */
function makeStore(seed: Record<string, Row[]>, gate: () => Promise<void> = async () => {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  let version = 0;
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let kind: 'select' | 'insert' | 'update' = 'select';
    let payload: unknown;
    let wantCount = false;
    const b: Record<string, unknown> = {};
    const matches = (row: Row) => Object.entries(filters).every(([key, value]) => (
      key.startsWith('in:') ? (value as unknown[]).includes(row[key.slice(3)]) : row[key] === value
    ));
    const resolve = async () => {
      const rows = tables[table] ?? (tables[table] = []);
      if (kind === 'insert') {
        const inserted = (Array.isArray(payload) ? payload : [payload]) as Row[];
        rows.push(...inserted.map((p) => ({ ...p, id: p.id ?? `${table}-${rows.length + 1}` })));
        return { data: inserted[0] ?? null, error: null, count: null };
      }
      if (kind === 'update') {
        // The write half of the race: both callers have already read by now.
        if (table === 'approval_requests') await gate();
        const hit = rows.filter(matches);
        for (const r of hit) {
          Object.assign(r, payload as Record<string, unknown>);
          // The `set_updated_at` trigger (0003) bumps this on EVERY write, and
          // the fix uses it as the version token. A fake that left it alone
          // would let a broken compare-and-swap pass, so it is modelled here.
          if (table === 'approval_requests') r.updated_at = `v${++version}`;
        }
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
      single: async () => { const r = await resolve(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }; },
      maybeSingle: async () => { const r = await resolve(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }; },
      then: (ok: (v: unknown) => void, err?: (e: unknown) => void) => resolve().then(ok, err),
    });
    return b;
  };
  const db = { from } as unknown as SupabaseClient<Database>;
  holder.service = db;
  return { db, tables };
}

const NOW = new Date('2026-09-05T12:00:00Z');
const MEMBERS: Row[] = [
  { id: 'mum', family_id: 'fam-1', display_name: 'Mum', role: 'parent', is_active: true },
  { id: 'dad', family_id: 'fam-1', display_name: 'Dad', role: 'parent', is_active: true },
  { id: 'gran', family_id: 'fam-1', display_name: 'Gran', role: 'parent', is_active: true },
];

function scopeWith(db: SupabaseClient<Database>, memberId: string): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: `auth-${memberId}`, memberId, role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW,
  } as ServiceScope;
}

function twoParentRow(): Row {
  return {
    id: 'appr-1', family_id: 'fam-1', domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'concierge', title: 'Add soccer Saturday', summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool', amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier',
    approval_model: 'two_parent', required_approvals: 2, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2026-09-07T12:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], consequences: [], evidence: null,
    edited_payload: null, reviewed_by: null, review_note: null,
    created_at: '2026-09-05T10:00:00Z', updated_at: '2026-09-05T10:00:00Z',
  };
}

/**
 * Three approvals required, one already recorded. This is the shape that tells
 * a DECIDING vote apart from a non-deciding one: a second approval leaves the
 * request pending, while a rejection decides it immediately.
 */
function threeApprovalRow(): Row {
  return {
    ...twoParentRow(),
    approval_model: 'consensus',
    required_approvals: 3,
    approvals: [{ member_id: 'gran', decision: 'approved', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }],
  };
}

beforeEach(() => { holder.service = null; });

describe('two parents approving at once both count', () => {
  it('does not lose a vote when the writes interleave', async () => {
    // Hold the FIRST write until the second caller has also read. That is the
    // production race: two phones, one push notification, two taps.
    let held: null | (() => void) = null;
    const release = () => { held?.(); };
    let first = true;
    const gate = async () => {
      if (!first) return;
      first = false;
      await new Promise<void>((resolve) => { held = resolve as () => void; });
    };
    const { db, tables } = makeStore({ approval_requests: [twoParentRow()], family_members: MEMBERS }, gate);

    const mum = decide(scopeWith(db, 'mum'), 'appr-1', 'approved');
    // Let Mum reach her write and park there, then let Dad read and write.
    await new Promise((r) => setTimeout(r, 0));
    const dad = decide(scopeWith(db, 'dad'), 'appr-1', 'approved');
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([mum, dad]);

    const row = tables.approval_requests[0] as unknown as { approvals: { member_id: string }[]; status: string };
    const voters = (row.approvals ?? []).map((v) => v.member_id).sort();
    expect(voters, 'a parent’s vote was overwritten by the other parent’s write').toEqual(['dad', 'mum']);
    expect(row.status, 'two parents approved, so the request should be approved').toBe('approved');
  });

  it('still records a single approval normally', async () => {
    // The positive control: with nothing racing it, one vote lands and the
    // request stays pending for the second parent.
    const { db, tables } = makeStore({ approval_requests: [twoParentRow()], family_members: MEMBERS });
    const res = await decide(scopeWith(db, 'mum'), 'appr-1', 'approved');
    expect(res.ok).toBe(true);
    const row = tables.approval_requests[0] as unknown as { approvals: { member_id: string }[]; status: string };
    expect(row.approvals.map((v) => v.member_id)).toEqual(['mum']);
    expect(row.status).toBe('pending');
  });

  it('still refuses the same parent voting twice', async () => {
    // The other control: fixing the lost update must not weaken the existing
    // one-vote-per-member guard.
    const { db } = makeStore({ approval_requests: [twoParentRow()], family_members: MEMBERS });
    await decide(scopeWith(db, 'mum'), 'appr-1', 'approved');
    const again = await decide(scopeWith(db, 'mum'), 'appr-1', 'approved');
    expect(again.ok).toBe(false);
  });
});

describe('a deciding vote does not clobber one cast beside it', () => {
  // The deciding write guards on `status = 'pending'` like the others, and that
  // is still TRUE when another parent's non-deciding vote has just landed. So
  // pinning the version only on the non-deciding path left the exact case that
  // loses a vote: a rejection is always deciding.
  it('keeps an approval that landed while a rejection was being computed', async () => {
    let held: null | (() => void) = null;
    const release = () => { held?.(); };
    let first = true;
    const gate = async () => {
      if (!first) return;
      first = false;
      await new Promise<void>((resolve) => { held = resolve as () => void; });
    };
    const { db, tables } = makeStore({ approval_requests: [threeApprovalRow()], family_members: MEMBERS }, gate);

    // Dad's rejection reaches its write and parks (it DECIDES: status→rejected).
    const dad = decide(scopeWith(db, 'dad'), 'appr-1', 'rejected');
    await new Promise((r) => setTimeout(r, 0));
    // Mum's approval reads and writes behind it (non-deciding: 2 of 3).
    const mum = decide(scopeWith(db, 'mum'), 'appr-1', 'approved');
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([dad, mum]);

    const row = tables.approval_requests[0] as unknown as { approvals: { member_id: string }[]; status: string };
    const voters = (row.approvals ?? []).map((v) => v.member_id).sort();
    expect(voters, 'a vote was dropped by the deciding write').toEqual(['dad', 'gran', 'mum']);
    expect(row.status, 'one rejection still stops the request').toBe('rejected');
  });

  // Control: the deciding write must still be exclusive — two rejections at
  // once must not both be recorded as the decision.
  it('still refuses a second decision once one has landed', async () => {
    const { db } = makeStore({ approval_requests: [threeApprovalRow()], family_members: MEMBERS });
    const first = await decide(scopeWith(db, 'dad'), 'appr-1', 'rejected');
    expect(first.ok).toBe(true);
    const second = await decide(scopeWith(db, 'mum'), 'appr-1', 'rejected');
    expect(second.ok).toBe(false);
  });
});
