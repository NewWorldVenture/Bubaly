// The bearer calendar route refuses a closed or trial-ended family (N5).
//
// On the web the same family is stopped by `app/(app)/layout.tsx`'s
// AccountClosedGate / TrialPaywallGate before any calendar page renders. The
// phone's Today and Calendar tabs read GET /api/calendar/occurrences with a
// bearer token, and the handler went from the bearer context and the header
// assertion straight to the read: a family whose trial ended unpaid, or whose
// account was closed, kept reading its household calendar (titles, times,
// locations, two weeks) from the phone. The lock half only (`refuseIfLocked`):
// the Calendar page carries no `requireFeature` tier, so a tier gate here would
// make the phone stricter than the web.
//
// The standing read is the real one (lib/server/plan.ts), seeded through the
// service client it reads with. The phone's transport then names the lock in
// its own words (mobile/src/lib/queries.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { mobileTranslate } from '../mobile/src/lib/mobile-i18n';

const h = vi.hoisted(() => ({ read: vi.fn(), admin: null as unknown as { from: (table: string) => unknown }, superAdmin: false }));
vi.mock('@/lib/supabase/bearer', async original => ({ ...await original<typeof import('@/lib/supabase/bearer')>(), getBearerUserContext: h.read }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.admin, createServer: async () => h.admin }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => h.superAdmin }));
const phone = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: phone.session } } }));
vi.mock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://example.invalid' } }));
import { GET } from '@/app/api/calendar/occurrences/route';
const queriesModule = '../mobile/src/lib/queries';
const { fetchUpcomingEvents } = await import(queriesModule);

const FAMILY = '00000000-0000-4000-8000-0000000f0001';
const USER = '00000000-0000-4000-8000-0000000f1001';
let db: InMemorySupabase;
let admin: InMemorySupabase;
const request = () => new NextRequest(`https://example.invalid/api/calendar/occurrences?fromDay=2026-03-08&days=3`, { headers: { authorization: 'Bearer synthetic.jwt', 'X-Bubaly-User-Id': USER, 'X-Bubaly-Family-Id': FAMILY } });
const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
const future = new Date(Date.now() + 2 * 86_400_000).toISOString();

beforeEach(() => {
  db = createInMemorySupabase();
  admin = createInMemorySupabase();
  h.admin = admin;
  h.superAdmin = false;
  db.seed('calendar_events', [{ id: 'dentist', family_id: FAMILY, title: 'Dentist', starts_at: '2026-03-08T14:00:00Z', ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, location: 'Oak St', category: 'health' }]);
  h.read.mockReset().mockResolvedValue({ ok: true, supabase: db, ctx: { user: { id: USER }, active: { familyId: FAMILY, family: { timezone: 'America/New_York' } } } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/calendar/occurrences and the account’s standing', () => {
  it('serves an open family, in trial or grandfathered', async () => {
    admin.seed('families', [{ id: FAMILY, trial_ends_at: future, closed_at: null }]);
    const trial = await GET(request());
    expect(trial.status).toBe(200);
    expect((await trial.json()).occurrences).toHaveLength(1);
    admin.replace('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
    expect((await GET(request())).status).toBe(200);
  });

  it('refuses a closed account with its code and reads no calendar', async () => {
    admin.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: past }]);
    const res = await GET(request());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'account_closed', needLevel: 1 });
    expect(body).not.toHaveProperty('occurrences');
    expect(db.log.filter((entry) => entry.table === 'calendar_events')).toEqual([]);
  });

  it('refuses a trial that ended unpaid, and admits it again once a subscription is paid', async () => {
    admin.seed('families', [{ id: FAMILY, trial_ends_at: past, closed_at: null }]);
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'trial_expired', needLevel: 1 });
    admin.seed('subscriptions', [{ id: 'sub', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: future }]);
    expect((await GET(request())).status).toBe(200);
  });

  it('lets a super administrator preview a locked family, as every other gate does', async () => {
    admin.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: past }]);
    h.superAdmin = true;
    expect((await GET(request())).status).toBe(200);
  });

  it('answers 503, not a calendar, when the standing cannot be read', async () => {
    // No families row at all: the standing read throws rather than guessing.
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'unavailable' });
    expect(db.log.filter((entry) => entry.table === 'calendar_events')).toEqual([]);
  });
});

describe('the phone names the lock in its own words', () => {
  const owner = { userId: USER, familyId: FAMILY, memberId: 'member', timezone: 'America/New_York' };
  beforeEach(() => { phone.session.mockReset().mockResolvedValue({ data: { session: { user: { id: USER }, access_token: 'synthetic.jwt' } }, error: null }); });

  it.each([['account_closed', 'mobileAssistant.accountClosed'], ['trial_expired', 'mobileAssistant.trialEnded']] as const)('for %s, from the route’s own code rather than its English', async (code, key) => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'raw server wording', code, needLevel: 1 }, { status: 403 }));
    try {
      await expect(fetchUpcomingEvents(owner)).rejects.toMatchObject({ code, message: mobileTranslate('en-US', key) });
      await expect(fetchUpcomingEvents(owner)).rejects.not.toThrow('raw server wording');
    } finally { vi.unstubAllGlobals(); }
  });
});
