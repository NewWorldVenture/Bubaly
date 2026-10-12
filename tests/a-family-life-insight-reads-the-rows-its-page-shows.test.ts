import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

// The family-life AI Assist kinds on POST /api/ai/insights, driven through the
// real route against an in-memory database that refuses a column PostgREST does
// not know (42703), the way the real one does.
//
//   wishlists     read only the UNBOUGHT wishes, the owner's own included, so
//                 "list everything on my list" told them what was bought (F2/F5)
//   insurance     read the medical-card table, ordered by a column it lacks:
//                 "No policies tracked." on every call (F28)
//   celebrations  ordered family_dates by `date`, which is `event_date`: "none
//                 found" on every call, and no member birthdays (F29)
//   rides         the 30 OLDEST rides, and a 'pending' status that cannot exist
//                 (F31)
//   votes         read `is_closed` and `title`, which family_polls never had:
//                 every poll "open", none decided (F24/F30)
//   nine kinds    turned a failed read into an empty household at 200 (F32)
//   utilities     answered a guest a summary of every bill (F6)
//   celebrations, wishlists  were not gated like their catalog pages (F34)

const FAMILY = 'family-one';
const ME = 'member-me';
const SIBLING = 'member-sib';

const COLUMNS: Record<string, Set<string>> = {
  // 0009's medical-card table: no renewal_date, premium or policy_type.
  insurance_policies: new Set(['id', 'family_id', 'member_id', 'provider', 'plan_name', 'member_number', 'group_number', 'created_at']),
  family_dates: new Set(['id', 'family_id', 'member_id', 'title', 'kind', 'event_date', 'notes', 'remind_days', 'created_at']),
};
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'order']);

const h = vi.hoisted(() => ({
  db: null as unknown, complete: vi.fn(), role: 'parent' as string,
  refuse: vi.fn(async (_db: unknown, _familyId: string, _hrefs: readonly string[]) => null as Response | null),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-me' },
    active: { familyId: FAMILY, role: h.role, member: { id: ME }, family: { timezone: 'America/Los_Angeles', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: h.refuse }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

const { POST } = await import('@/app/api/ai/insights/route');

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

function schemaFault(table: string, calls: FaultCall[]) {
  const known = COLUMNS[table];
  if (!known) return null;
  const unknown = calls.find((c) => FILTERS.has(c.method) && typeof c.args[0] === 'string' && !known.has(c.args[0] as string));
  return unknown ? { code: '42703', message: `column ${table}.${String(unknown.args[0])} does not exist` } : null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 18:00 on Monday 12 October in Los Angeles — already the 13th at Greenwich.
  vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.role = 'parent';
  h.refuse.mockReset().mockResolvedValue(null);
  h.db = withFaults(base, (table, calls) => (table === failing ? { message: 'Fixture read refused' } : schemaFault(table, calls)));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [
    { id: ME, family_id: FAMILY, display_name: 'Ada', is_active: true, birthday: null },
    { id: SIBLING, family_id: FAMILY, display_name: 'Ben', is_active: true, birthday: '2015-10-20' },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = (kind: string, question?: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...(question ? { question } : {}) }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('wishlists: the owner is not told which of their wishes were bought (F2/F5)', () => {
  beforeEach(() => {
    base.seed('wishlist_items', [
      { id: 'w1', family_id: FAMILY, member_id: ME, title: 'Telescope', priority: 'high', is_purchased: true, claimed_by: SIBLING },
      { id: 'w2', family_id: FAMILY, member_id: ME, title: 'Paint set', priority: 'low', is_purchased: false, claimed_by: null },
      { id: 'w3', family_id: FAMILY, member_id: SIBLING, title: 'Skateboard', priority: 'medium', is_purchased: true, claimed_by: ME },
      { id: 'w4', family_id: FAMILY, member_id: SIBLING, title: 'Kite', priority: 'medium', is_purchased: false, claimed_by: null },
    ]);
  });

  it('lists every one of my own wishes, bought or not, with no gift state', async () => {
    const response = await ask('wishlists', 'List every item on my own wishlist.');
    expect(response.status).toBe(200);
    const text = prompt();
    expect(text).toContain('Ada wants: Telescope');
    expect(text).toContain('Ada wants: Paint set');
    expect(text).not.toContain('[purchased]');
  });

  it('still leaves out another member\'s bought wishes', async () => {
    await ask('wishlists');
    expect(prompt()).toContain('Ben wants: Kite');
    expect(prompt()).not.toContain('Skateboard');
  });
});

describe('the owner\'s own list on screen does not sort bought wishes last (F2/F5)', () => {
  it('orders my wishes by priority and title only', async () => {
    const { sortWishes } = await import('@/lib/wishlists/gifts');
    const mine = [
      { id: 'a', member_id: ME, title: 'Apron', priority: 'medium' as const, claimed_by: null, is_purchased: false },
      { id: 'b', member_id: ME, title: 'Bike', priority: 'medium' as const, claimed_by: SIBLING, is_purchased: true },
    ];
    // The order the module renders the owner's own tab in.
    expect(sortWishes(mine, { viewerMemberId: ME }).map((w) => w.title)).toEqual(['Apron', 'Bike']);
    expect(sortWishes([mine[1], mine[0]], { viewerMemberId: ME }).map((w) => w.title)).toEqual(['Apron', 'Bike']);
    const reversed = [{ ...mine[0], title: 'Zither' }, mine[1]];
    // Bought or not, Bike sorts before Zither on its title alone.
    expect(sortWishes(reversed, { viewerMemberId: ME }).map((w) => w.title)).toEqual(['Bike', 'Zither']);
    // Another viewer still sees bought wishes last.
    expect(sortWishes(reversed, { viewerMemberId: SIBLING }).map((w) => w.title)).toEqual(['Zither', 'Bike']);
  });
});

describe('insurance reads the Insurance Hub\'s policies (F28)', () => {
  it('describes the family\'s policies rather than "No policies tracked."', async () => {
    base.seed('family_insurance_policies', [
      { id: 'p1', family_id: FAMILY, policy_type: 'home', insurer: 'Acme Mutual', premium_amount: 120, premium_frequency: 'monthly', renewal_date: '2026-11-01', is_active: true },
    ]);
    const response = await ask('insurance');
    expect(response.status).toBe(200);
    expect(prompt()).toContain('home: Acme Mutual');
    expect(prompt()).toContain('2026-11-01');
    expect(prompt()).not.toContain('No policies tracked');
  });

  it('is for the adults, like the premiums it summarises', async () => {
    h.role = 'child';
    const response = await ask('insurance');
    expect(response.status).toBe(403);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('celebrations reads event_date and the members\' birthdays (F29)', () => {
  it('names what is coming up from the family\'s day', async () => {
    base.seed('family_dates', [
      { id: 'd1', family_id: FAMILY, title: 'Wedding anniversary', kind: 'anniversary', event_date: '2010-10-24' },
    ]);
    const response = await ask('celebrations');
    expect(response.status).toBe(200);
    const text = prompt();
    expect(text).toContain('Wedding anniversary');
    expect(text).toContain("Ben's birthday");
    expect(text).not.toContain('none found');
    expect(text).toContain('Total saved dates: 1');
  });
});

describe('rides counts what is ahead and what is unconfirmed (F31)', () => {
  it('reads from the family\'s today, not the 30 oldest rides', async () => {
    base.seed('rides', Array.from({ length: 35 }, (_, i) => ({
      id: `past-${i}`, family_id: FAMILY, title: `Old ride ${i}`, ride_date: `2026-0${1 + (i % 8)}-1${i % 10}`, status: 'completed',
    })));
    base.seed('rides', [
      { id: 'today', family_id: FAMILY, title: 'Practice pickup', ride_date: '2026-10-12', status: 'planned' },
      { id: 'later', family_id: FAMILY, title: 'Dentist', ride_date: '2026-10-20', status: 'confirmed' },
    ]);
    const response = await ask('rides');
    expect(response.status).toBe(200);
    expect(prompt()).toContain('Upcoming rides: 2.');
    expect(prompt()).toContain('Pending/unconfirmed: 1.');
  });
});

describe('votes reads question and status (F24/F30)', () => {
  it('counts a closed poll as decided and names each poll by its question', async () => {
    base.seed('family_polls', [
      { id: 'poll-open', family_id: FAMILY, question: 'Pizza or tacos?', status: 'open', closes_at: null, created_at: '2026-10-10T00:00:00Z' },
      { id: 'poll-closed', family_id: FAMILY, question: 'Beach or mountains?', status: 'closed', closes_at: null, created_at: '2026-10-09T00:00:00Z' },
      { id: 'poll-lapsed', family_id: FAMILY, question: 'Movie night film?', status: 'open', closes_at: '2026-10-01T00:00:00Z', created_at: '2026-10-08T00:00:00Z' },
    ]);
    base.seed('family_poll_options', [{ id: 'o1', family_id: FAMILY, poll_id: 'poll-open', label: 'Pizza', sort: 0 }]);
    base.seed('family_poll_votes', [{ id: 'v1', family_id: FAMILY, poll_id: 'poll-open', option_id: 'o1', member_id: ME }]);
    const response = await ask('votes');
    expect(response.status).toBe(200);
    expect(prompt()).toContain('3 total (1 open, 2 decided)');
    expect(prompt()).toContain('Pizza or tacos?');
    expect(prompt()).toContain('"label":"Pizza","votes":1');
  });
});

describe('a failed read is not an empty household (F32)', () => {
  const READS: [string, string][] = [
    ['pets', 'pets'], ['pets', 'pet_care_records'],
    ['subscriptions', 'subscriptions_tracked'],
    ['wishlists', 'wishlist_items'],
    ['insurance', 'family_insurance_policies'],
    ['celebrations', 'family_dates'],
    ['screen_time', 'screen_time_entries'], ['screen_time', 'screen_time_limits'],
    ['utilities', 'utility_bills'],
    ['rides', 'rides'],
    ['votes', 'family_polls'], ['votes', 'family_poll_options'], ['votes', 'family_poll_votes'],
  ];
  it.each(READS)('%s: a failed %s read answers "could not load" and the model is not asked', async (kind, table) => {
    failing = table;
    const response = await ask(kind);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('the pets prompt is handed the care records it asks the model to flag', async () => {
    base.seed('pets', [{ id: 'pet-1', family_id: FAMILY, name: 'Rex', species: 'dog', breed: 'beagle', is_active: true }]);
    base.seed('pet_care_records', [
      { id: 'c1', family_id: FAMILY, pet_id: 'pet-1', kind: 'vaccination', title: 'Rabies booster', record_date: '2025-10-01', next_due: '2026-10-01' },
    ]);
    const response = await ask('pets');
    expect(response.status).toBe(200);
    expect(prompt()).toContain('Rex: Rabies booster (vaccination)');
    expect(prompt()).toContain('next due 2026-10-01');
  });
});

describe('a guest is not summarised the household\'s bills (F6)', () => {
  it('refuses the utilities kind to a guest, and answers everyone else', async () => {
    base.seed('utility_bills', [{ id: 'b1', family_id: FAMILY, kind: 'electric', period_month: '2026-09-01', amount_cents: 14000 }]);
    h.role = 'guest';
    expect((await ask('utilities')).status).toBe(403);
    expect(h.complete).not.toHaveBeenCalled();
    h.role = 'caregiver';
    expect((await ask('utilities')).status).toBe(200);
  });
});

describe('celebrations and wishlists answer to their catalog gate (F34)', () => {
  it.each([['celebrations', '/dashboard/celebrations'], ['wishlists', '/dashboard/wishlists']])('%s is gated on %s', async (kind, href) => {
    h.refuse.mockImplementation(async (_db, _family, hrefs) => (hrefs.includes(href) ? new Response(null, { status: 403 }) : null));
    const response = await ask(kind);
    expect(response.status).toBe(403);
    expect(h.complete).not.toHaveBeenCalled();
  });
});
