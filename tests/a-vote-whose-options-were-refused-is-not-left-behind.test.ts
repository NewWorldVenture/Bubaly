import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createMealVote writes the vote and then its options, as two requests. When
 * the options were refused (a vault recipe deleted while the form was open —
 * the recipe_id foreign key — or a dropped connection), it returned the error
 * and left the vote behind: an open vote with nothing to vote on, on every
 * member's vote page, and the family's retry of the same form made a second
 * one. The vote is withdrawn now, and only a withdrawal that did not land is
 * reported as such. (SRV-001 census, SRV-C05.)
 */

const state = vi.hoisted(() => ({
  failOptions: false,
  failWithdraw: false,
  votes: new Set<string>(),
  optionRows: 0,
}));

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let op = 'select';
      let payload: unknown;
      const chain = () => b;
      Object.assign(b, {
        select: chain, eq: chain,
        insert: (p: unknown) => { op = 'insert'; payload = p; return b; },
        delete: () => { op = 'delete'; return b; },
        single: async () => {
          if (table === 'meal_votes' && op === 'insert') { state.votes.add('vote-1'); return { data: { id: 'vote-1' }, error: null }; }
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          let reply: { data: unknown; error: unknown } = { data: null, error: null };
          if (table === 'meal_vote_options' && op === 'insert') {
            if (state.failOptions) reply = { data: null, error: { code: '23503', message: 'insert or update violates foreign key constraint' } };
            else state.optionRows += (payload as unknown[]).length;
          }
          if (table === 'meal_votes' && op === 'delete') {
            if (state.failWithdraw) reply = { data: [], error: null };
            else { state.votes.delete('vote-1'); reply = { data: [{ id: 'vote-1' }], error: null }; }
          }
          return Promise.resolve(reply).then(resolve);
        },
      });
      return b;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'fam-1', role: 'parent', member: { id: 'm1' } } }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createMealVote } = await import('@/app/(app)/dashboard/recipes/vote/actions');

const INPUT = { title: 'Friday dinner', options: [{ label: 'Tacos', recipeId: 'r-1' }, { label: 'Pizza' }] };

beforeEach(() => { state.failOptions = false; state.failWithdraw = false; state.votes.clear(); state.optionRows = 0; });

describe('a vote whose options were refused is not left behind', () => {
  it('withdraws the vote when its options could not be saved', async () => {
    state.failOptions = true;
    const res = await createMealVote(INPUT);
    expect(res.ok).toBe(false);
    expect(state.votes.size).toBe(0);
  });

  it('still reports the failure when the withdrawal is refused too', async () => {
    state.failOptions = true;
    state.failWithdraw = true;
    const res = await createMealVote(INPUT);
    expect(res.ok).toBe(false);
  });

  it('keeps a vote whose options landed', async () => {
    const res = await createMealVote(INPUT);
    expect(res).toEqual({ ok: true, id: 'vote-1' });
    expect(state.votes.has('vote-1')).toBe(true);
    expect(state.optionRows).toBe(2);
  });
});
