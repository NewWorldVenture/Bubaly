import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Closing an account sets `families.closed_at` and is presented as a pause;
 * every screen is behind the closed-account gate from then on. The weekly
 * digest cron (app/api/cron/weekly-digest/route.ts) skips a closed family, but
 * tests/a-closed-family-is-left-alone-by-the-crons.test.ts drives every other
 * sender and not this one. This drives it: a closed family gets no Monday
 * email, and a family that reopens gets it again.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  users: [] as { id: string; email: string | null }[],
  sends: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: async () => ({ users: h.users, error: null }) }));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async ({ to }: { to: string }) => { h.sends.push(to); return { ok: true }; },
}));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  readCompleteCalendarOccurrences: async () => ({ ok: true, data: { occurrences: [], totalVisibleCount: 0, horizonEndsAt: '' } }),
}));

import { GET as weeklyDigest } from '@/app/api/cron/weekly-digest/route';

const OPEN = 'fam-open';
const CLOSED = 'fam-closed';
const req = () => new Request('https://bubaly.test/api/cron/weekly-digest') as never;

beforeEach(() => {
  const db = createInMemorySupabase();
  db.seed('families', [
    { id: OPEN, name: 'Open family', timezone: 'UTC', closed_at: null },
    { id: CLOSED, name: 'Closed family', timezone: 'UTC', closed_at: '2026-09-01T00:00:00.000Z' },
  ]);
  db.seed('family_members', [
    { id: 'm-open', family_id: OPEN, user_id: 'u-open', display_name: 'Open parent', role: 'parent', is_active: true },
    { id: 'm-closed', family_id: CLOSED, user_id: 'u-closed', display_name: 'Closed parent', role: 'parent', is_active: true },
  ]);
  h.db = db;
  h.users = [{ id: 'u-open', email: 'open@synthetic.invalid' }, { id: 'u-closed', email: 'closed@synthetic.invalid' }];
  h.sends = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a family that closed its account', () => {
  it('gets no weekly digest', async () => {
    const res = await weeklyDigest(req());
    expect(h.sends, 'emailed a closed family its week ahead').toEqual(['open@synthetic.invalid']);
    expect(res.status).toBe(200);
  });

  it('gets it again once it reopens', async () => {
    (h.db as InMemorySupabase).table('families').find((f) => f.id === CLOSED)!.closed_at = null;
    await weeklyDigest(req());
    expect(h.sends.sort()).toEqual(['closed@synthetic.invalid', 'open@synthetic.invalid']);
  });
});
