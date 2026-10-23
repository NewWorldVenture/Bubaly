// One generator per family at a time, and one morning brief per family per day.
//
// generateFamilyNotifications dedupes by READING the family's notifications
// and then INSERTING the batch that is not there yet; `notifications` has no
// unique key to refuse a second writer. Two generation passes for one family
// inside that read→insert window — the push scan and the notifications cron on
// their mirrored minute, or a member's Scan while a cron is on their family —
// both read "absent" and both inserted, and each copy was pushed (and the
// personal ones emailed). The morning brief had the same shape: its own prior
// read, then notify()'s read-then-insert, and two 11:00 ticks filed it twice.
//
// The database key is the owner's migration; until it lands, a per-family
// lease in app_settings keeps the two writers apart
// (lib/server/notification-generation-lease.ts, lib/briefing/deliver.ts).
//
// Behavioural: two push-scan ticks, and a tick beside a Scan press, driven
// concurrently against the in-memory database with the REAL generator; two
// concurrent morning-brief passes. The count after the race equals the count
// after one pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-parent' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-parent' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/server/push', () => ({ dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }) }));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, skipped: 0, failed: 0 } }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

const { GET: pushScan } = await import('@/app/api/cron/push-scan/route');
const { POST: scan } = await import('@/app/api/notifications/generate/route');
const { deliverMorningBriefs } = await import('@/lib/briefing/deliver');

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-1';
const NOW = new Date('2026-09-30T12:00:00.000Z');
let db: InMemorySupabase;
const req = (path: string) => new Request(`https://bubaly.test${path}`) as never;
const notices = (type?: string) => db.table('notifications').filter((n) => !type || n.type === type);

function household() {
  db = createInMemorySupabase({
    defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } },
    // app_settings' primary key: the fence of a lease's first claim (23505 for the second inserter).
    uniques: { app_settings: [['key']] },
  });
  h.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Ada', birthday: null },
    { id: 'm-adult', family_id: FAMILY, user_id: 'u-adult', role: 'adult', is_active: true, display_name: 'Ben', birthday: null },
    { id: 'm-kid', family_id: FAMILY, user_id: 'u-kid', role: 'child', is_active: true, display_name: 'Cy', birthday: null },
  ]);
  // A chore due in three hours: one `chore_due` notification per generation pass that does not dedupe.
  db.seed('chores', [{ id: 'ch-1', family_id: FAMILY, title: 'Feed the cat' }]);
  db.seed('chore_assignments', [{ id: 'ca-1', family_id: FAMILY, chore_id: 'ch-1', member_id: 'm-kid', status: 'todo', due_at: '2026-09-30T15:00:00.000Z' }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  household();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the "who needs to know" generator', () => {
  it('one pass files the chore reminder once (calibrates the race below)', async () => {
    await pushScan(req('/api/cron/push-scan'));
    expect(notices('chore_due')).toHaveLength(1);
    expect(notices('chore_due')[0]).toMatchObject({ user_id: 'u-kid', related_id: 'ca-1' });
  });

  it('two push-scan ticks on the same minute file it once', async () => {
    const [a, b] = await Promise.all([pushScan(req('/api/cron/push-scan')), pushScan(req('/api/cron/push-scan'))]);
    expect(notices('chore_due'), 'both passes read "absent" and both inserted').toHaveLength(1);
    const bodies = await Promise.all([a.json(), b.json()]);
    // One generated, the other found the family held — neither failed.
    expect(bodies.map((body) => body.generationHeld).sort()).toEqual([0, 1]);
    for (const body of bodies) expect(body).toMatchObject({ ok: true, failed: 0 });
  });

  it('a Scan pressed while the cron is on the family files it once', async () => {
    const [tick, press] = await Promise.all([pushScan(req('/api/cron/push-scan')), scan()]);
    expect(notices('chore_due')).toHaveLength(1);
    expect(tick.status).toBe(200);
    expect(press.status).toBe(200);
  });

  it('releases the family once a pass is done, so the next pass is not skipped', async () => {
    const first = await (await pushScan(req('/api/cron/push-scan'))).json();
    expect(first).toMatchObject({ generationHeld: 0 });
    db.seed('chore_assignments', [{ id: 'ca-2', family_id: FAMILY, chore_id: 'ch-1', member_id: 'm-kid', status: 'todo', due_at: '2026-09-30T16:00:00.000Z' }]);
    const second = await (await pushScan(req('/api/cron/push-scan'))).json();
    expect(second).toMatchObject({ generationHeld: 0 });
    expect(notices('chore_due')).toHaveLength(2);
  });
});

describe('the morning brief', () => {
  beforeEach(() => {
    db.seed('calendar_events', [{
      id: 'ev-1', family_id: FAMILY, title: 'Dentist', starts_at: '2026-09-30T14:00:00.000Z', ends_at: '2026-09-30T15:00:00.000Z', all_day: false, location: null,
      description: null, category: 'general', recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
      created_by: 'u-parent', onboarding_key: null, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    }]);
  });

  it('one pass tells each manager once (calibrates the race below)', async () => {
    const result = await deliverMorningBriefs(db as unknown as DB, NOW);
    expect(result).toMatchObject({ delivered: 1, failed: 0 });
    expect(notices().filter((n) => n.related_type === 'brief').map((n) => n.user_id).sort()).toEqual(['u-adult', 'u-parent']);
  });

  it('two concurrent ticks tell each manager once', async () => {
    const [a, b] = await Promise.all([deliverMorningBriefs(db as unknown as DB, NOW), deliverMorningBriefs(db as unknown as DB, NOW)]);
    expect(notices().filter((n) => n.related_type === 'brief').map((n) => n.user_id).sort(), 'every manager got two briefs').toEqual(['u-adult', 'u-parent']);
    expect(a.delivered + b.delivered).toBe(1);
    expect(a.failed + b.failed).toBe(0);
  });
});
