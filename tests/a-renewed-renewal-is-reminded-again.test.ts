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
 *
 * And the rows already written under the OLD keys are honoured (audit note of
 * 2026-10-04 07:34 UTC): a renewal announced under its bare id inside this
 * occurrence's window is not announced again on the first run with the dated
 * key; one announced under the bare id a year ago (the previous occurrence) is.
 * Each candidate names the legacy key it may already stand under and the
 * instant from which such a row counts; the engine's one dedupe read answers
 * both.
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

describe('rows written under the old keys are honoured (audit 2026-10-04 07:34)', () => {
  const legacyRow = (over: Record<string, unknown>) => ({
    id: `legacy-${Math.random().toString(36).slice(2)}`, family_id: FAMILY, user_id: 'u-parent', type: 'document_expiry',
    title: 'Renewal due: Car insurance', body: 'old', is_read: false, pushed_at: null, send_at: null, ...over,
  });

  it('a renewal announced under its bare id INSIDE this occurrence\'s window is not announced again on the first dated run', async () => {
    // The old engine wrote this two days ago, inside the two-week lead of the 13 October expiry.
    db.seed('notifications', [legacyRow({ related_type: 'renewals', related_id: RENEWAL, created_at: '2026-10-01T08:00:00.000Z' })]);
    expect(await generate(), 'only the passport is new').toBe(1);
    expect(notices('renewals').map((n) => n.key)).toEqual([RENEWAL]);
    // Next year is a new occurrence: the dated key, announced.
    Object.assign(db.table('renewals').find((r) => r.id === RENEWAL)!, { expires_at: rollForward('2026-10-13', 12) });
    vi.setSystemTime(YEAR_TWO);
    expect(await generate()).toBe(1);
    expect(notices('renewals').map((n) => n.key)).toEqual([RENEWAL, `${RENEWAL}:2027-10-13`]);
  });

  it('a renewal announced under its bare id a YEAR ago — the previous occurrence — is announced now', async () => {
    db.seed('notifications', [legacyRow({ related_type: 'renewals', related_id: RENEWAL, created_at: '2025-10-01T08:00:00.000Z' })]);
    expect(await generate()).toBe(2);
    expect(notices('renewals').map((n) => n.key)).toEqual([RENEWAL, `${RENEWAL}:2026-10-13`]);
  });

  it('the boundary is the start of the lead window: a legacy row the day before it does not count, one on it does', async () => {
    // Expires 13 Oct, lead 14 days: the window opens 29 Sep.
    db.seed('notifications', [legacyRow({ related_type: 'renewals', related_id: RENEWAL, created_at: '2026-09-28T23:59:59.000Z' })]);
    expect(await generate()).toBe(2);
    db.seed('notifications', [legacyRow({ related_type: 'renewals', related_id: `${RENEWAL}-b`, created_at: '2026-09-29T00:00:00.000Z' })]);
    db.seed('renewals', [{ id: `${RENEWAL}-b`, family_id: FAMILY, title: 'Home insurance', expires_at: '2026-10-13', reminder_days: 14, status: 'active' }]);
    expect(await generate(), 'the second renewal is already announced for this occurrence').toBe(0);
  });

  it('a legacy row for ANOTHER manager does not stand in for this one', async () => {
    db.seed('family_members', [{ id: 'other-parent', family_id: FAMILY, user_id: 'u-other', role: 'parent', is_active: true, display_name: 'Other', birthday: null }]);
    db.seed('notifications', [legacyRow({ related_type: 'renewals', related_id: RENEWAL, user_id: 'u-other', created_at: '2026-10-01T08:00:00.000Z' })]);
    await generate();
    expect(notices('renewals').filter((n) => n.user_id === 'u-parent').map((n) => n.key)).toEqual([`${RENEWAL}:2026-10-13`]);
    expect(notices('renewals').filter((n) => n.user_id === 'u-other').map((n) => n.key)).toEqual([RENEWAL]);
  });

  it('a document announced under `${document}:${manager}` inside its 14-day window is not announced again; a year-old one is', async () => {
    db.seed('notifications', [legacyRow({ type: 'document_expiry', related_type: 'documents', related_id: `${DOCUMENT}:${PARENT}`, created_at: '2026-10-02T08:00:00.000Z' })]);
    expect(await generate(), 'only the renewal is new').toBe(1);
    expect(notices('documents').map((n) => n.key)).toEqual([`${DOCUMENT}:${PARENT}`]);

    db = createInMemorySupabase<DB>();
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Parent', birthday: null }]);
    db.seed('documents', [{ id: DOCUMENT, family_id: FAMILY, title: 'Passport', expires_at: '2026-10-08T00:00:00.000Z', is_secure: false, category: 'identity' }]);
    db.seed('notifications', [legacyRow({ type: 'document_expiry', related_type: 'documents', related_id: `${DOCUMENT}:${PARENT}`, created_at: '2025-10-02T08:00:00.000Z' })]);
    expect(await generate()).toBe(1);
    expect(notices('documents').map((n) => n.key)).toEqual([`${DOCUMENT}:${PARENT}`, `${DOCUMENT}:2026-10-08:${PARENT}`]);
  });
});
