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
import { readFileSync } from 'node:fs';
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
  // Rows keep every column the filer wrote: a resend is matched on what the
  // row says (filer, payload), not only on its key.
  const rows: Array<Record<string, unknown> & { id: string; family_id: string; dedupe_key: string | null; status: string }> = [];
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
          return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
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
                const row = { ...payload, id: `appr-${++n}`, family_id: payload.family_id as string, dedupe_key: key, status: 'pending' };
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

// The trust bridge is not the only filer. `lib/ai/tools/execute.ts` opens its own
// approval row when the RISK TIER tightened an `allow` the engine had already
// permitted — a path the original finding did not name. Left keyless it would
// have kept filing duplicate cards on the registry/concierge path while the chat
// path was fixed, which is the worst of both: half a guarantee, undocumented.
describe('both filers use one definition of "the same action"', () => {
  const src = readFileSync('lib/ai/tools/execute.ts', 'utf8');

  it('the registry path stamps a key rather than filing keyless rows', () => {
    // A keyless row is exempt from 0273's partial index by design, so forgetting
    // the key here is silent: no error, no duplicate protection. The key goes
    // through the shared filer, which stamps it on every insert except the one
    // filed beside a row planted under the key (see approval-dedupe-reuse).
    expect(src).toContain('approvalDedupeKey(scope.familyId');
    expect(src).toMatch(/fileOrReusePendingApproval\(writer, scope\.familyId, dedupeKey,/);
    expect(src).toContain('dedupe_key: key');
  });

  it('it checks before inserting and recovers from the race', () => {
    // Both filers share one lookup-insert-23505 routine, so the registry path
    // cannot drift from the chat path that the race tests above exercise.
    const shared = readFileSync('lib/trust/server.ts', 'utf8');
    expect(shared).toContain(".eq('family_id', familyId).eq('dedupe_key', dedupeKey).eq('status', 'pending')");
    expect(shared).toContain("first.error?.code === '23505'");
    expect(src).not.toContain(".from('approval_requests')\n    .select('id').eq('family_id', scope.familyId).eq('dedupe_key'");
  });

  it('imports the shared key rather than hand-rolling a second one', () => {
    // Two hashes of "the same action" that disagree are worse than one: each
    // path would dedupe against itself and neither against the other.
    expect(src).toMatch(/import \{[^}]*approvalDedupeKey[^}]*\} from '@\/lib\/trust\/server'/);
  });
});

// `dedupe_key` is not pinned by the member insert policy (0255) and the key is
// a sha256 of values the asker knows. Reusing ANY pending row under the key let
// an adult plant `{malicious payload, dedupe_key = K}`, ask Bubaly for the
// harmless thing, have the gate "reuse" their row and write Bubaly's ai_agent
// audit line against it, flip requested_by_kind to 'ai', and approve alone —
// `filedByBubaly` then said yes and the trust gate was skipped.
describe('a row planted under the key is never reused as Bubaly\'s', () => {
  const K = approvalDedupeKey('fam-1', REQ);
  const genuine = { family_id: 'fam-1', dedupe_key: K, status: 'pending', requested_by_kind: 'ai', requested_by_member_id: 'member-teen', domain: 'tasks', capability: 'create', payload: REQ.payload };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a different payload, filed by the member', { requested_by_kind: 'member', payload: { name: 'transfer_money', args: { cents: 99999 } } }],
    ['a different payload, already flipped to ai', { payload: { name: 'transfer_money', args: { cents: 99999 } } }],
    ['the same payload but a member filer', { requested_by_kind: 'member' }],
    ['the same payload but another asker', { requested_by_member_id: 'member-parent' }],
    ['another capability', { capability: 'delete' }],
  ];
  for (const [label, over] of cases) {
    it(`files its own row beside one with ${label}`, async () => {
      const { db, rows, inserts } = makeDb();
      rows.push({ ...genuine, ...over, id: 'planted' });
      const opened = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
      expect(opened).not.toBeNull();
      expect(opened?.id).not.toBe('planted');
      expect(opened?.alreadyPending).toBe(false);
      // Keyless, so 0273's index (which the planted row holds) cannot refuse it.
      expect(inserts).toHaveLength(1);
      expect(inserts[0].dedupe_key).toBeNull();
      expect(inserts[0].payload).toEqual(REQ.payload);
    });
  }

  it('also when the planted row only appears after the race (23505 recovery)', async () => {
    const { db, rows, inserts } = makeDb({ blindLookups: 1 });
    rows.push({ ...genuine, requested_by_kind: 'member', payload: { name: 'transfer_money', args: {} }, id: 'planted' });
    const opened = await openApprovalRequest(db, 'fam-1', REQ, DECISION);
    expect(opened?.id).not.toBe('planted');
    expect(opened?.alreadyPending).toBe(false);
    expect(inserts.map((i) => i.dedupe_key)).toEqual([K, null]);
  });

  it('still reuses the genuine row (not over-tightened)', async () => {
    const { db, rows, inserts } = makeDb();
    rows.push({ ...genuine, id: 'genuine' });
    expect(await openApprovalRequest(db, 'fam-1', REQ, DECISION)).toEqual({ id: 'genuine', alreadyPending: true });
    expect(inserts).toHaveLength(0);
  });
});
