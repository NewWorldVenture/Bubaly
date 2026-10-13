// `castBallot` (app/(app)/dashboard/recipes/vote/actions.ts) upserted the
// ballot without asking whether the vote was still open. The vote page stops
// offering the buttons once a vote is closed, but a page left open from before
// someone closed it, or a direct call, still changed the counts on a dinner the
// family had already decided, and the tally shown under the winner moved with
// it. Nothing in RLS looks at the vote's status. The action now reads the vote
// first: a closed vote is refused with its own message, and a vote it cannot
// read, or cannot find in this family, is refused without writing anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'child', member: { id: 'mem-kid' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { castBallot } = await import('@/app/(app)/dashboard/recipes/vote/actions');

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { meal_vote_ballots: [['option_id', 'member_id']] } });
  db.seed('meal_votes', [
    { id: 'vote-open', family_id: 'fam-1', title: 'Friday dinner', status: 'open', winner_option_id: null },
    { id: 'vote-closed', family_id: 'fam-1', title: 'Sunday lunch', status: 'closed', winner_option_id: 'opt-roast' },
    { id: 'vote-other', family_id: 'fam-2', title: 'Their dinner', status: 'open', winner_option_id: null },
  ]);
  db.seed('meal_vote_options', [
    { id: 'opt-tacos', vote_id: 'vote-open', family_id: 'fam-1', label: 'Tacos' },
    { id: 'opt-roast', vote_id: 'vote-closed', family_id: 'fam-1', label: 'Roast' },
    { id: 'opt-soup', vote_id: 'vote-closed', family_id: 'fam-1', label: 'Soup' },
    { id: 'opt-theirs', vote_id: 'vote-other', family_id: 'fam-2', label: 'Curry' },
  ]);
  db.seed('meal_vote_ballots', [
    { id: 'b-1', vote_id: 'vote-closed', option_id: 'opt-roast', family_id: 'fam-1', member_id: 'mem-kid', choice: 'yes' },
  ]);
  state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ballots = () => db.table('meal_vote_ballots');

describe('castBallot', () => {
  it('refuses a ballot on a closed vote and leaves its counts alone', async () => {
    expect(await castBallot({ voteId: 'vote-closed', optionId: 'opt-soup', choice: 'yes' }))
      .toEqual({ ok: false, error: 'actions.thatVoteIsClosed' });
    expect(await castBallot({ voteId: 'vote-closed', optionId: 'opt-roast', choice: 'no' }))
      .toEqual({ ok: false, error: 'actions.thatVoteIsClosed' });
    expect(ballots()).toEqual([expect.objectContaining({ id: 'b-1', option_id: 'opt-roast', choice: 'yes' })]);
  });

  it('records a ballot on an open vote, and a changed mind replaces it', async () => {
    expect(await castBallot({ voteId: 'vote-open', optionId: 'opt-tacos', choice: 'maybe' })).toEqual({ ok: true });
    expect(await castBallot({ voteId: 'vote-open', optionId: 'opt-tacos', choice: 'yes' })).toEqual({ ok: true });
    const mine = ballots().filter((row) => row.vote_id === 'vote-open');
    expect(mine).toEqual([expect.objectContaining({ option_id: 'opt-tacos', family_id: 'fam-1', member_id: 'mem-kid', choice: 'yes' })]);
  });

  it('refuses a vote it cannot find in this family, and writes nothing', async () => {
    expect(await castBallot({ voteId: 'vote-other', optionId: 'opt-theirs', choice: 'yes' }))
      .toEqual({ ok: false, error: 'actions.couldNotRecordYourVote' });
    expect(ballots()).toHaveLength(1);
  });

  it('does not take a failed read of the vote for an open one', async () => {
    const realFrom = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = realFrom(table) as unknown as Record<string, unknown>;
      if (table === 'meal_votes') {
        const failed = () => Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } });
        builder.maybeSingle = failed;
        builder.single = failed;
      }
      return builder;
    }) as unknown as typeof db.from);
    expect(await castBallot({ voteId: 'vote-open', optionId: 'opt-tacos', choice: 'yes' }))
      .toEqual({ ok: false, error: 'actions.couldNotRecordYourVote' });
    expect(ballots()).toHaveLength(1);
  });
});
