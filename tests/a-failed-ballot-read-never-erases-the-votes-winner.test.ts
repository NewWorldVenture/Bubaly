// Closing a meal vote must never turn a failed read into "nobody voted".
//
// `closeMealVote` destructured only `data` from its two reads:
//
//     const [{ data: options }, { data: ballots }] = await settleAll([...])
//
// so a refused read arrived as `null` — indistinguishable from "this vote has no
// options / no ballots yet". Both were then coerced with `?? []`, and
// `winningOption(tallyVotes([], []))` returns `null` for an empty tally, which is
// exactly what a genuinely unvoted vote returns. The UPDATE on the next line
// stamped `status: 'closed', winner_option_id: null` over a vote where tacos had
// beaten pizza 3-0, the action returned `{ ok: true }`, and vote-client toasted
// "Vote closed". The family is left with a closed vote that still displays
// "3 yes" on tacos and crowns nobody, and the "Add winner to grocery list"
// button — the whole point of the feature — refuses with "No winner yet".
// Reopening cannot recover the verdict; the ballots survive, but the stamp does
// not come back until someone closes it again on a healthy connection.
//
// These drive the real action with one read failing at a time and require a
// failed read to produce a DIFFERENT outcome than an empty one. The old code
// passed the empty-vote assertions here identically to the failed-read ones,
// which is the defect itself: nothing downstream could tell them apart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReadResult = { data: unknown; error: unknown } | 'reject';

const reads = vi.hoisted(() => ({
  options: { data: [] as unknown, error: null as unknown } as ReadResult,
  ballots: { data: [] as unknown, error: null as unknown } as ReadResult,
}));

/** Every `meal_votes` UPDATE the action actually issued. */
const updates: Record<string, unknown>[] = [];

function fakeClient() {
  const answer = (table: string): Promise<{ data: unknown; error: unknown; count: null }> => {
    const result = table === 'meal_vote_options' ? reads.options : reads.ballots;
    if (result === 'reject') return Promise.reject(new Error('CONNECT_TIMEOUT'));
    return Promise.resolve({ ...result, count: null });
  };
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'limit']) chain[method] = () => chain;
    chain.update = (values: Record<string, unknown>) => {
      updates.push(values);
      return chain;
    };
    const settled = () => (table === 'meal_votes'
      ? Promise.resolve({ data: null, error: null, count: null })
      : answer(table));
    chain.maybeSingle = settled;
    chain.single = settled;
    chain.then = (...args: unknown[]) => settled().then(...(args as [never, never]));
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { closeMealVote } = await import('@/app/(app)/dashboard/recipes/vote/actions');

// Tacos beat pizza 3-0 — the verdict the family is owed.
const OPTIONS = [{ id: 'opt-tacos' }, { id: 'opt-pizza' }];
const BALLOTS = [
  { option_id: 'opt-tacos', choice: 'yes' },
  { option_id: 'opt-tacos', choice: 'yes' },
  { option_id: 'opt-tacos', choice: 'yes' },
];

beforeEach(() => {
  updates.length = 0;
  reads.options = { data: OPTIONS, error: null };
  reads.ballots = { data: BALLOTS, error: null };
});
afterEach(() => vi.restoreAllMocks());

describe('closing a meal vote when a read fails', () => {
  it('refuses to close when the ballots read is refused, and writes nothing', async () => {
    reads.ballots = { data: null, error: { message: 'permission denied for relation meal_vote_ballots' } };
    const result = await closeMealVote('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('permission denied');
    expect(updates).toEqual([]);
  });

  it('refuses to close when the options read is refused, and writes nothing', async () => {
    reads.options = { data: null, error: { message: 'permission denied for relation meal_vote_options' } };
    const result = await closeMealVote('vote-1');
    expect(result.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  // A transport failure REJECTS rather than resolving with { error }; settleAll
  // is what delivers it in the same { data: null, error } shape. Before the fix
  // it landed in the same `?? []` as everything else.
  it('refuses to close when a read never completed', async () => {
    reads.ballots = 'reject';
    const result = await closeMealVote('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('CONNECT_TIMEOUT');
    expect(updates).toEqual([]);
  });

  // The heart of it: the outcome of a failed read must not be the outcome of a
  // vote nobody has voted on. Before the fix both stamped winner_option_id: null
  // and returned { ok: true }.
  it('does not do to a refused read what it does to a vote nobody voted on', async () => {
    reads.ballots = { data: null, error: { message: 'permission denied for relation meal_vote_ballots' } };
    const failed = await closeMealVote('vote-1');
    const afterFailed = [...updates];

    updates.length = 0;
    reads.ballots = { data: [], error: null };
    const empty = await closeMealVote('vote-1');

    expect({ result: failed, writes: afterFailed }).not.toEqual({ result: empty, writes: [...updates] });
  });
});

// Negative controls. Without these, "writes nothing" above would also pass on an
// action that refuses to close any vote at all.
describe('closing a meal vote when the reads succeed', () => {
  it('stamps the option the family actually chose', async () => {
    const result = await closeMealVote('vote-1');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(updates).toEqual([{ status: 'closed', winner_option_id: 'opt-tacos' }]);
  });

  it('still closes a vote nobody voted on, with no winner', async () => {
    reads.ballots = { data: [], error: null };
    const result = await closeMealVote('vote-1');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(updates).toEqual([{ status: 'closed', winner_option_id: null }]);
  });
});
