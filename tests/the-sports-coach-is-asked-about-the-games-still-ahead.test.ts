import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';

// The Sports page's AI Assist ("AI sports coach", kind `sports` on
// POST /api/ai/insights), driven through the REAL route against an in-memory
// database.
//
// The route read the family's fifteen OLDEST `sports_events`, ascending with
// no lower bound. A family that had used the Sports page for a season had more
// than fifteen practices and games on file, all of them over, so the coach was
// handed only those under "Upcoming events" and asked for "the next game to
// prepare for". It answered about a game played in June and never saw
// Saturday's. Neither read went through `required()`, so a refused read
// reached the model as "No events." / "No teams." at HTTP 200. And the prompt
// printed each event's day as `starts_at.slice(0, 10)`, Greenwich's date: a
// 5:30 pm Saturday game in Los Angeles is 00:30 on Sunday at Greenwich, and
// the coach was told Sunday.

const FAMILY = 'family-one';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    active: { familyId: FAMILY, role: 'parent', member: { id: 'member-parent' }, family: { timezone: 'America/Los_Angeles', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/ai/insights/route');

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

const DAY = 86_400_000;
const event = (id: string, title: string, startsAt: string, over: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, member_id: null, sport: 'Soccer', team: 'Thunder FC', title,
  event_type: 'practice', location: 'Riverside Park', starts_at: startsAt, ends_at: null,
  recurrence: 'none', recurrence_until: null, created_by: 'user-parent', ...over,
});

// Sixteen Tuesday practices from June to September: all over by October.
const pastPractices = Array.from({ length: 16 }, (_, i) => event(
  `past-${String(i).padStart(2, '0')}`, `Practice week ${i + 1}`,
  new Date(Date.parse('2026-06-03T00:00:00Z') + i * 7 * DAY).toISOString(),
));
// Saturday 17 October, 5:30 pm in Los Angeles: 00:30 on Sunday at Greenwich.
const saturdayGame = event('game', 'Game vs Storm FC', '2026-10-18T00:30:00Z', { event_type: 'game', location: 'Lincoln Field' });
// Sixteen more practices after it, so more than fifteen rows lie ahead.
const laterPractices = Array.from({ length: 16 }, (_, i) => event(
  `later-${String(i).padStart(2, '0')}`, `Late-season practice ${i + 1}`,
  new Date(Date.parse('2026-10-21T00:00:00Z') + i * 7 * DAY).toISOString(),
));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 18:00 on Monday 12 October in Los Angeles, already the 13th at Greenwich.
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-parent', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
  base.seed('teams', [{ id: 'team-1', family_id: FAMILY, member_id: null, sport: 'Soccer', team_name: 'Thunder FC', season: 'Fall 2026', coach: null, is_active: true, created_by: 'user-parent' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = () => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'sports' }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('the AI sports coach is asked about what is still ahead', () => {
  it('a family with a season of past practices on file is asked about Saturday\'s game, not June\'s practice', async () => {
    base.seed('sports_events', [...pastPractices, saturdayGame]);
    const response = await ask();
    expect(response.status).toBe(200);
    const text = prompt();
    expect(text).toContain('Game vs Storm FC');
    expect(text).not.toContain('Practice week');
  });

  it('with more than fifteen events ahead, the soonest ones are the ones it is given', async () => {
    base.seed('sports_events', [...laterPractices, saturdayGame, ...pastPractices]);
    expect((await ask()).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Game vs Storm FC');
    expect(text).toContain('Late-season practice 1 ');
    // The prompt lists the soonest ten: the game and the next nine practices,
    // and nothing that is already over.
    expect(text).toContain('Late-season practice 9 ');
    expect(text).not.toContain('Late-season practice 10 ');
    expect(text).not.toContain('Practice week');
    expect(at(text, 'Game vs Storm FC')).toBeLessThan(at(text, 'Late-season practice 1 '));
  });

  it('a clinic earlier today that is already over is not upcoming', async () => {
    // 10:00 on Monday in Los Angeles; it is 18:00 there now.
    base.seed('sports_events', [event('clinic', 'Morning skills clinic', '2026-10-12T17:00:00Z'), saturdayGame]);
    expect((await ask()).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Game vs Storm FC');
    expect(text).not.toContain('Morning skills clinic');
  });

  it("an event's day and time are the family's, not Greenwich's", async () => {
    base.seed('sports_events', [saturdayGame]);
    expect((await ask()).status).toBe(200);
    const text = prompt();
    expect(text).toContain('Game vs Storm FC (2026-10-17 17:30');
    expect(text).not.toContain('2026-10-18');
  });

  it('a family with nothing ahead is told so, and is not handed its past instead', async () => {
    base.seed('sports_events', pastPractices);
    expect((await ask()).status).toBe(200);
    const text = prompt();
    expect(text).toContain('No events.');
    expect(text).not.toContain('Practice week');
    expect(text).toContain('Thunder FC');
  });

  it.each(['sports_events', 'teams'])('a refused %s read is an error, not an empty schedule at HTTP 200', async (table) => {
    base.seed('sports_events', [saturdayGame]);
    failing = table;
    const response = await ask();
    expect(response.status).toBe(500);
    expect(h.complete).not.toHaveBeenCalled();
  });
});
