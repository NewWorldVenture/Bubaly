// A resent chat message must not put two identical cards in a parent's inbox.
//
// `openApprovalRequest` was an unguarded INSERT and nothing on `approval_requests`
// stopped a second identical row, so a flaky connection mid-answer, a
// double-tapped send, a reloaded tab or Bubaly's own retry filed TWO pending
// approvals for one intent. A parent sees two cards that look like the same thing
// they wanted, approves both, and the resource is written twice.
//
// This is where a gated family's duplicate actually comes from, and the tool
// ledger's idempotency reservation cannot help: `executeTool` returns
// `pending_approval` at step 3, BEFORE the reservation at step 4 — so for every
// family that turned approvals on, that protection has never been reached.
import { describe, expect, it, vi } from 'vitest';
import { approvalDedupeKey, openApprovalRequest } from '@/lib/trust/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

vi.mock('@/lib/trust/ledger', () => ({
  ledgerWriter: (db: unknown) => Promise.resolve(db),
}));

const DECISION = { effect: 'require_approval' as const, reason: 'tier', basis: 'role_default' as const };
const REQ = {
  actor: { kind: 'ai_agent' as const, id: 'assistant', role: 'parent' as const },
  domain: 'tasks',
  capability: 'create' as const,
  agent: 'AI Assistant',
  title: 'Add task: "Bins"',
  payload: { name: 'add_todo', args: { task: 'Bins' } },
  onBehalfOfMemberId: 'member-teen',
};

/**
 * A table that behaves like `approval_requests` under 0273: pending rows are
 * unique on (family_id, dedupe_key), and a violation surfaces as 23505 the way
 * PostgREST reports it.
 */
function makeDb(opts: { blindLookups?: number } = {}) {
  const rows: Array<{ id: string; family_id: string; dedupe_key: string | null; status: string }> = [];
  let n = 0;
  let blind = opts.blindLookups ?? 0;
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    from: () => {
      const q: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (c: string, v: unknown) => { filters[c] = v; return q; },
        limit: () => q,
        maybeSingle: () => {
          // `blindLookups` reproduces the race: a lookup that ran before the
          // other request committed sees nothing, so the caller goes on to
          // insert and must be caught by the index rather than by this check.
          if (blind > 0) { blind -= 1; return Promise.resolve({ data: null, error: null }); }
          const hit = rows.find((r) => r.family_id === filters.family_id
            && r.dedupe_key === filters.dedupe_key && r.status === filters.status);
          return Promise.resolve({ data: hit ? { id: hit.id } : null, error: null });
        },
        insert: (payload: Record<string, unknown>) => {
          inserts.push(payload);
          const key = payload.dedupe_key as string | null;
          const clash = key !== null && rows.some((r) => r.family_id === payload.family_id
            && r.dedupe_key === key && r.status === 'pending');
          return {
            select: () => ({
              single: () => {
                if (clash) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
                const row = { id: `appr-${++n}`, family_id: payload.family_id as string, dedupe_key: key, status: 'pending' };
                rows.push(row);
                return Promise.resolve({ data: { id: row.id }, error: null });
              },
            }),
          };
        },
      });
      return q;
    },
  } as unknown as SupabaseClient<Database>;
  return { db, rows, inserts };
}

describe('one pending approval per request, however many times it is sent', () => {
  it('files a card the first time', async () => {
    const { db, rows } = makeDb();
    const opened = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    expect(opened).toEqual({ id: 'appr-1', alreadyPending: false });
    expect(rows).toHaveLength(1);
  });

  it('returns the SAME card on a resend, and says it was already waiting', async () => {
    const { db, rows } = makeDb();
    const first = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    const second = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    expect(second?.id).toBe(first?.id);
    expect(second?.alreadyPending).toBe(true);
    // The point of the whole change: one row, so approving it writes once.
    expect(rows).toHaveLength(1);
  });

  it('survives two resends racing past the lookup, via the unique index', async () => {
    // Both requests read the table before either committed, so neither
    // pre-check sees the other. One insert wins; the loser gets 23505 and must
    // come back with the WINNER's id — a null there would tell the family
    // "Bubaly could not send that for approval" about a card already sitting in
    // their inbox. `blindLookups: 2` blinds both pre-checks and leaves the
    // loser's post-23505 recovery lookup sighted, which is exactly the ordering
    // the race produces.
    const { db, rows } = makeDb({ blindLookups: 2 });
    const winner = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    const loser = await openApprovalRequest(db, 'fam-1', REQ, DECISION);

    expect(winner?.alreadyPending).toBe(false);
    expect(loser?.id).toBe(winner?.id);
    expect(loser?.alreadyPending).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('does not collapse two DIFFERENT asks', async () => {
    const { db, rows } = makeDb();
    await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    await openApprovalRequest(db, 'fam-1',
      { ...REQ, payload: { name: 'add_todo', args: { task: 'Recycling' } } }, DECISION);
    expect(rows).toHaveLength(2);
  });

  it('does not collapse the same ask from two different people', async () => {
    // Emma and Jack each asking for the same chore are two requests, and a
    // parent must be able to answer them separately.
    const { db, rows } = makeDb();
    await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    await openApprovalRequest(db, 'fam-1', { ...REQ, onBehalfOfMemberId: 'member-jack' }, DECISION);
    expect(rows).toHaveLength(2);
  });

  it('does not collapse across families', async () => {
    const { db, rows } = makeDb();
    await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    await openApprovalRequest(db, 'fam-2', REQ, DECISION);
    expect(rows).toHaveLength(2);
  });

  it('stamps the key on the row, so the index has something to enforce', async () => {
    const { db, inserts } = makeDb();
    await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    expect(inserts[0].dedupe_key).toBe(approvalDedupeKey('fam-1', REQ));
  });
});

describe('the dedupe key describes the ASK, not how the engine described it', () => {
  it('ignores key order in the payload', async () => {
    // Two code paths can assemble the same arguments in a different sequence;
    // JSON.stringify preserves insertion order, so an unsorted hash would treat
    // them as different asks and file two cards.
    const a = { ...REQ, payload: { name: 'add_todo', args: { task: 'Bins', due: 'friday' } } };
    const b = { ...REQ, payload: { args: { due: 'friday', task: 'Bins' }, name: 'add_todo' } };
    expect(approvalDedupeKey('fam-1', a)).toBe(approvalDedupeKey('fam-1', b));
  });

  it('ignores the title and summary the engine wrote', () => {
    // These are the engine's description of the request. If a reworded title
    // changed the key, a resend would file a second card.
    expect(approvalDedupeKey('fam-1', { ...REQ, title: 'Add task: "Bins"', summary: 'x' }))
      .toBe(approvalDedupeKey('fam-1', { ...REQ, title: 'Something else entirely', summary: 'y' }));
  });

  it('separates a member asking from Bubaly asking for them', () => {
    const byMember = { ...REQ, actor: { kind: 'member' as const, id: 'member-teen', role: 'teen' as const }, agent: undefined };
    expect(approvalDedupeKey('fam-1', byMember)).not.toBe(approvalDedupeKey('fam-1', REQ));
  });

  it('separates different capabilities on the same payload', () => {
    expect(approvalDedupeKey('fam-1', { ...REQ, capability: 'delete' as const }))
      .not.toBe(approvalDedupeKey('fam-1', REQ));
  });
});
