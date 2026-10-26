// The brief names the coming trip, not the family's old ones.
//
// Nothing in the app moves `vacations.status` past 'planning', so both brief
// reads, the morning brief the cron pushes to the managers (`readMorningBrief`,
// lib/briefing/deliver.ts) and the Briefing page (`POST /api/ai/briefing`),
// read "trips not completed or cancelled" as EVERY dated trip ever made, in no
// order, twenty of them:
//   - a trip that ended in July reached the digest with a start in the past,
//     which `classify` files as OVERDUE, so every morning the managers were
//     told "1 overdue" about last summer's holiday;
//   - with twenty trips on file, the one leaving on Thursday could simply not
//     be among the twenty rows that came back.
// Both now read the trips that are not over (end date, else start date, on or
// after the family's today), soonest first with a stable tie-break.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readMorningBrief, morningTarget } from '@/lib/briefing/deliver';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: mocks.server,
  createServiceClient: () => entitledServiceClient(),
}));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => false, resolveProvider: async () => ({ complete: vi.fn() }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
import { POST } from '@/app/api/ai/briefing/route';

type DB = SupabaseClient<Database>;

// Monday 7 September 2026, 7am in New York.
const TICK = new Date('2026-09-07T11:00:00Z');
const TZ = 'America/New_York';

const trip = (familyId: string, id: string, title: string, start: string, end: string | null): Row => ({
  id, family_id: familyId, title, destination: null, status: 'planning', start_date: start, end_date: end,
});

type Shape = 'old' | 'far' | 'tied';

/**
 * `old`: 25 trips that ended, inserted first. `far`: 22 trips next year,
 * inserted first. `tied`: 21 trips leaving the same Thursday, ids after
 * 'a-lake', inserted first. In every shape the Lake week trip (Thursday) is
 * inserted LAST, so a read in insertion order with a limit of 20 drops it.
 */
function family(db: InMemorySupabase, familyId: string, shape: Shape) {
  db.seed('families', [{ id: familyId, timezone: TZ }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: familyId, user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true }]);
  const filler = shape === 'old'
    ? Array.from({ length: 25 }, (_, i) => trip(familyId, `old-${String(i).padStart(2, '0')}`, `Old trip ${i}`, `2025-0${(i % 9) + 1}-01`, `2025-0${(i % 9) + 1}-05`))
    : shape === 'far'
      ? Array.from({ length: 22 }, (_, i) => trip(familyId, `far-${String(i).padStart(2, '0')}`, `Next year ${i}`, `2027-0${(i % 9) + 1}-01`, `2027-0${(i % 9) + 1}-05`))
      : Array.from({ length: 21 }, (_, i) => trip(familyId, `z-${String(i).padStart(2, '0')}`, `Same day ${i}`, '2026-09-10', '2026-09-12'));
  // In the `old` shape a trip whose last day is today is still under way.
  const home = shape === 'old' ? [trip(familyId, 'b-home', 'Coming home today', '2026-09-03', '2026-09-07')] : [];
  db.seed('vacations', [...filler, ...home, trip(familyId, 'a-lake', 'Lake week', '2026-09-10', '2026-09-17')]);
}

type DigestItem = { domain: string; title: string; urgency: string };
const trips = (items: DigestItem[]) => items.filter((item) => item.domain === 'trip');

describe('the morning brief the managers are sent', () => {
  it('does not call a trip that ended last year overdue', async () => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1', 'old');
    const brief = await readMorningBrief(scopeForSystem(db, { id: 'fam-1', timezone: TZ }, { now: TICK }), morningTarget(TICK, TZ));
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(trips(brief.data.digest.items).map((item) => item.title).sort()).toEqual(['Coming home today', 'Lake week']);
    expect(brief.data.digest.counts.overdue).toBe(0);
  });

  it.each(['far', 'tied'] as const)('names Thursday\'s trip behind twenty others (%s)', async (shape) => {
    const db = createInMemorySupabase<DB>();
    family(db, 'fam-1', shape);
    const brief = await readMorningBrief(scopeForSystem(db, { id: 'fam-1', timezone: TZ }, { now: TICK }), morningTarget(TICK, TZ));
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(trips(brief.data.digest.items).map((item) => item.title)).toContain('Lake week');
  });
});

describe('the Briefing page', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TICK);
    db = createInMemorySupabase<DB>();
    mocks.server.mockResolvedValue(db);
    mocks.context.mockResolvedValue({
      user: { id: 'auth-parent' },
      active: { familyId: 'family', role: 'parent', member: { id: 'm-parent', display_name: 'Alex' }, family: { name: 'Family', timezone: TZ } },
    });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const brief = async () => {
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));
    expect(response.status).toBe(200);
    return (await response.json()) as { digest: { items: DigestItem[]; counts: { overdue: number } } };
  };

  it('does not call a trip that ended last year overdue', async () => {
    family(db, 'family', 'old');
    const body = await brief();
    expect(trips(body.digest.items).map((item) => item.title).sort()).toEqual(['Coming home today', 'Lake week']);
    expect(body.digest.counts.overdue).toBe(0);
  });

  it.each(['far', 'tied'] as const)('names Thursday\'s trip behind twenty others (%s)', async (shape) => {
    family(db, 'family', shape);
    expect(trips((await brief()).digest.items).map((item) => item.title)).toContain('Lake week');
  });
});
