import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// N1 — the votes kind of POST /api/ai/insights listed the family's fifteen
// newest polls, then read `family_poll_options` and `family_poll_votes` as the
// first sixty rows of each — in no order, for any poll. A family whose older
// polls held sixty votes was told its newest poll had none, and the model
// nudged everyone to vote on a question they had already decided.
//
// Driven through the real route against an in-memory database that, like
// PostgREST, answers an unordered read in storage order.

const FAMILY = 'family-one';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-me' },
    active: { familyId: FAMILY, role: 'parent', member: { id: 'member-me' }, family: { timezone: 'UTC', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/ai/insights/route');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(db, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [{ id: 'member-me', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
});
afterEach(() => { vi.restoreAllMocks(); });

const ask = () => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'votes' }),
}));
const recent = () => {
  const content = (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
  const json = content.slice(content.indexOf('Recent: ') + 'Recent: '.length, content.indexOf('.\n\nGive:'));
  return JSON.parse(json) as { question: string; options: { label: string; votes: number }[] }[];
};

/** An older poll, stored first, holding `n` votes between its two options. */
function seedOldPoll(index: number, n: number) {
  const id = `old-${index}`;
  db.seed('family_polls', [{ id, family_id: FAMILY, question: `Old question ${index}`, status: 'closed', closes_at: null, created_at: `2026-0${index + 1}-01T00:00:00Z` }]);
  db.seed('family_poll_options', [
    { id: `${id}-a`, family_id: FAMILY, poll_id: id, label: 'Yes', sort: 0 },
    { id: `${id}-b`, family_id: FAMILY, poll_id: id, label: 'No', sort: 1 },
  ]);
  db.seed('family_poll_votes', Array.from({ length: n }, (_, v) => ({
    id: `${id}-v${v}`, family_id: FAMILY, poll_id: id, option_id: v % 2 ? `${id}-b` : `${id}-a`, member_id: `voter-${v}`,
  })));
}

describe('the votes insight tallies the polls it lists', () => {
  it("the newest poll's votes are counted when older polls hold more than sixty", async () => {
    seedOldPoll(1, 40);
    seedOldPoll(2, 40);
    db.seed('family_polls', [{ id: 'new', family_id: FAMILY, question: 'Pizza or tacos tonight?', status: 'open', closes_at: null, created_at: '2026-10-10T00:00:00Z' }]);
    db.seed('family_poll_options', [
      { id: 'new-pizza', family_id: FAMILY, poll_id: 'new', label: 'Pizza', sort: 0 },
      { id: 'new-tacos', family_id: FAMILY, poll_id: 'new', label: 'Tacos', sort: 1 },
    ]);
    db.seed('family_poll_votes', [
      { id: 'nv1', family_id: FAMILY, poll_id: 'new', option_id: 'new-pizza', member_id: 'a' },
      { id: 'nv2', family_id: FAMILY, poll_id: 'new', option_id: 'new-pizza', member_id: 'b' },
      { id: 'nv3', family_id: FAMILY, poll_id: 'new', option_id: 'new-tacos', member_id: 'c' },
    ]);

    const response = await ask();
    expect(response.status).toBe(200);
    const [newest, ...older] = recent();
    expect(newest).toEqual({ question: 'Pizza or tacos tonight?', closed: false, options: [{ label: 'Pizza', votes: 2 }, { label: 'Tacos', votes: 1 }] });
    // The older polls listed beside it keep their own full tallies too.
    expect(older.map((p) => p.options.reduce((sum, o) => sum + o.votes, 0))).toEqual([40, 40]);
  });

  it('reads only the listed polls\' options and votes, in this family', async () => {
    seedOldPoll(1, 4);
    db.seed('family_poll_options', [{ id: 'elsewhere', family_id: 'family-two', poll_id: 'old-1', label: 'Not yours', sort: 2 }]);
    db.seed('family_poll_votes', [{ id: 'elsewhere-v', family_id: 'family-two', poll_id: 'old-1', option_id: 'old-1-a', member_id: 'x' }]);
    const response = await ask();
    expect(response.status).toBe(200);
    expect(recent()).toEqual([{ question: 'Old question 1', closed: true, options: [{ label: 'Yes', votes: 2 }, { label: 'No', votes: 2 }] }]);
  });

  it.each(['family_poll_options', 'family_poll_votes'])('a failed %s read still answers "could not load"', async (table) => {
    seedOldPoll(1, 2);
    failing = table;
    const response = await ask();
    expect(response.status).toBe(500);
    expect(h.complete).not.toHaveBeenCalled();
  });
});
