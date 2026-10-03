import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { entityIdFrom } from '@/lib/notifications/actions';
import { rollForward } from '@/lib/renewals/expiry';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A RENEWED RENEWAL WAS NEVER ANNOUNCED AGAIN. NOR WAS A RENEWED DOCUMENT.
 *
 * The notification engine dedupes PERMANENTLY on (type, related_id, user_id).
 * A renewal reminder's `related_id` was the renewal's id; a document's was
 * `${document}:${manager}`. Both rows are meant to live on: "Mark renewed"
 * (components/modules/renewals-module.tsx) rolls `expires_at` forward a year
 * and keeps the renewal active, and a passport's new expiry is written onto
 * the same document. So year one was announced and every year after it was
 * swallowed by the dedupe — car insurance and the passport each reminded
 * once, ever.
 *
 * Both keys now carry the expiry they are about. This runs the REAL engine
 * over the in-memory Supabase, renews between ticks the way the module does,
 * and moves the clock a year.
 */

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-ren';
const RENEWAL = '11111111-2222-4333-8444-555555555555';
const DOCUMENT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PARENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const YEAR_ONE = '2026-10-03T08:00:00.000Z';
const YEAR_TWO = '2027-10-03T08:00:00.000Z';

let db: ReturnType<typeof createInMemorySupabase<DB>>;
const notices = (type: string) => db.table('notifications')
  .filter((n) => n.related_type === type)
  .map((n) => ({ key: n.related_id as string, user_id: n.user_id as string | null }));
const generate = () => generateFamilyNotifications(db as unknown as DB, FAMILY);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(YEAR_ONE);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Parent', birthday: null }]);
  // Car insurance expires in ten days; its own lead is two weeks.
  db.seed('renewals', [{ id: RENEWAL, family_id: FAMILY, title: 'Car insurance', expires_at: '2026-10-13', reminder_days: 14, status: 'active' }]);
  // A passport expiring in five days (the engine's document window is 14).
  db.seed('documents', [{ id: DOCUMENT, family_id: FAMILY, title: 'Passport', expires_at: '2026-10-08T00:00:00.000Z', is_secure: false, category: 'identity' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a renewed renewal is reminded about again', () => {
  it('year one is announced once, and year two is a new notice', async () => {
    expect(await generate()).toBe(2);
    expect(notices('renewals')).toEqual([{ key: `${RENEWAL}:2026-10-13`, user_id: 'u-parent' }]);
    expect(await generate(), 'the same tick again writes nothing').toBe(0);
    // A day later, still the same occurrence: a key that carried TODAY rather
    // than the expiry would announce it every morning.
    vi.setSystemTime('2026-10-04T08:00:00.000Z');
    expect(await generate(), 'the next day is not a new notice').toBe(0);

    // "Mark renewed": the module rolls the expiry a year on and keeps it active.
    const row = db.table('renewals').find((r) => r.id === RENEWAL)!;
    Object.assign(row, { expires_at: rollForward(row.expires_at as string, 12), status: 'active' });
    expect(row.expires_at).toBe('2027-10-13');

    vi.setSystemTime(YEAR_TWO);
    expect(await generate(), 'next year is a new notice, not a duplicate').toBe(1);
    expect(notices('renewals').map((n) => n.key)).toEqual([`${RENEWAL}:2026-10-13`, `${RENEWAL}:2027-10-13`]);
    expect(await generate()).toBe(0);
  });

  it('a document given its renewed expiry is announced again', async () => {
    await generate();
    expect(notices('documents')).toEqual([{ key: `${DOCUMENT}:2026-10-08:${PARENT}`, user_id: 'u-parent' }]);

    // The passport is renewed; its new expiry is written onto the same row.
    Object.assign(db.table('documents').find((d) => d.id === DOCUMENT)!, { expires_at: '2027-10-08T00:00:00.000Z' });
    vi.setSystemTime(YEAR_TWO);
    expect(await generate()).toBe(1);
    expect(notices('documents').map((n) => n.key)).toEqual([`${DOCUMENT}:2026-10-08:${PARENT}`, `${DOCUMENT}:2027-10-08:${PARENT}`]);
    expect(await generate()).toBe(0);
  });

  it('the dated keys still deep-link to the row', () => {
    expect(entityIdFrom(`${RENEWAL}:2027-10-13`)).toBe(RENEWAL);
    expect(entityIdFrom(`${DOCUMENT}:2027-10-08:${PARENT}`)).toBe(DOCUMENT);
  });
});
