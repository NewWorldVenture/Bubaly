// The meal-voting page shows every ballot cast on the votes it shows.
//
// It read the twenty newest votes, then EVERY option and ballot the family had
// ever cast, unordered and unpaged. PostgREST caps a response at 1,000 rows
// (db-max-rows) without saying so, so once a family's history passed that —
// four people rating four options a week, about fifteen months — the open vote
// at the top came back with ballots missing: low tallies, the wrong leader,
// "you haven't voted". The options and ballots are now read for the shown
// votes only, ordered, and paged to a real ceiling.
//
// The real page against an in-memory database that applies the 1,000-row cap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { VoteView } from '@/app/(app)/dashboard/recipes/vote/vote-client';

const FAMILY = 'family-one';
const MEMBERS = ['m-1', 'm-2', 'm-3', 'm-4'];
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'm-1' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { default: MealVotePage } = await import('@/app/(app)/dashboard/recipes/vote/page');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/** The `n`th closed weekly vote since January 2025: four options, everyone rating every one. */
function pastVote(n: number) {
  const id = `vote-${String(n).padStart(3, '0')}`;
  db.seed('meal_votes', [{ id, family_id: FAMILY, title: `Week ${n}`, status: 'closed', created_at: new Date(Date.UTC(2025, 0, 1) + n * 7 * 86_400_000).toISOString() }]);
  const options = [1, 2, 3, 4].map((o) => ({ id: `${id}-opt-${o}`, vote_id: id, family_id: FAMILY, label: `Dish ${o}` }));
  db.seed('meal_vote_options', options);
  db.seed('meal_vote_ballots', options.flatMap((option) => MEMBERS.map((member) => ({
    id: `${option.id}-${member}`, vote_id: id, option_id: option.id, family_id: FAMILY, member_id: member, choice: 'yes',
  }))));
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ maxRows: 1000 });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Seventy past votes: 1,120 ballots, all written before this week's.
  for (let n = 0; n < 70; n += 1) pastVote(n);
  db.seed('meal_votes', [{ id: 'open', family_id: FAMILY, title: 'Friday dinner', status: 'open', created_at: '2026-10-12T09:00:00Z' }]);
  db.seed('meal_vote_options', [
    { id: 'open-tacos', vote_id: 'open', family_id: FAMILY, label: 'Tacos' },
    { id: 'open-pizza', vote_id: 'open', family_id: FAMILY, label: 'Pizza' },
  ]);
  db.seed('meal_vote_ballots', [
    { id: 'b-1', vote_id: 'open', option_id: 'open-tacos', family_id: FAMILY, member_id: 'm-1', choice: 'yes' },
    { id: 'b-2', vote_id: 'open', option_id: 'open-tacos', family_id: FAMILY, member_id: 'm-2', choice: 'yes' },
    { id: 'b-3', vote_id: 'open', option_id: 'open-pizza', family_id: FAMILY, member_id: 'm-3', choice: 'no' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const votes = async () => ((await MealVotePage()) as ReactElement<{ votes: VoteView[] }>).props.votes;

describe('the meal-voting page past a thousand ballots', () => {
  it('shows the open vote with every option and ballot cast on it', async () => {
    const shown = await votes();

    expect(shown).toHaveLength(20);
    const open = shown[0];
    expect(open.id).toBe('open');
    expect(open.options.map((o) => o.label).sort()).toEqual(['Pizza', 'Tacos']);
    expect(open.ballots).toHaveLength(3);
    expect(open.ballots.filter((b) => b.optionId === 'open-tacos')).toHaveLength(2);
  });

  it('every shown vote carries all of its own options and ballots, and only its own', async () => {
    for (const vote of (await votes()).slice(1)) {
      expect(vote.options, vote.id).toHaveLength(4);
      expect(vote.ballots, vote.id).toHaveLength(16);
      expect(vote.ballots.every((b) => b.optionId.startsWith(vote.id)), vote.id).toBe(true);
    }
  });
});
