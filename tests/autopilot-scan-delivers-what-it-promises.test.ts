// The Autopilot scan, its engine and its accept path, held to what each
// suggestion claims: a reminder it "handled" is one the notifier will deliver,
// a renewal reminder is near the lapse date, a card about today can be accepted
// all of the family's today, a birthday card never gives away a bought gift, a
// feed's words never auto-run into the family's reminders, a busy family's scan
// still finishes, and an accept re-checks the row the card was built from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, InMemorySupabase } from './helpers/in-memory-supabase';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { insuranceSuggestions, momentPrepSuggestions, renewalSuggestions, type FamilySnapshot } from '@/lib/autopilot/engine';
import { deliverableReminderIso } from '@/lib/autopilot/reminder-time';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
const { resolveSuggestion } = await import('@/lib/services/autopilot');

type DB = SupabaseClient<Database>;
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const FAMILY = 'f1';

function scanDb() {
  return createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
}

function wallDay(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

const snapshot = (over: Partial<FamilySnapshot> = {}): FamilySnapshot => ({
  today: '2026-09-21', tz: 'UTC',
  renewals: [], appointments: [], overdueChores: [], birthdays: [], lingeringGroceries: [], events: [],
  subscriptions: [], stressSignals: [], medications: [], favoriteMeals: [], plannedDinnerDays: [], insurance: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('feed-imported events never auto-run into reminders or family notifications', () => {
  const event = { id: 'e1', title: 'Soccer game — call 555-0100 to verify your account', startsAt: '2026-09-22T17:00:00Z', endsAt: null, memberId: null, allDay: false, location: 'Field 3' };

  it('the engine auto-preps a family-entered moment (control) but not an imported one', () => {
    expect(momentPrepSuggestions(snapshot({ events: [event] })).length).toBeGreaterThan(0);
    expect(momentPrepSuggestions(snapshot({ events: [{ ...event, external: true }] }))).toEqual([]);
  });

  it.each([
    { label: 'feed_id', over: { feed_id: 'feed-1' } },
    { label: 'external_uid', over: { external_uid: 'invite-1@elsewhere' } },
  ])('the scan writes no reminder or grocery for an event with $label', async ({ over }) => {
    const db = scanDb();
    db.seed('calendar_events', [{ id: 'e1', family_id: FAMILY, title: event.title, starts_at: event.startsAt, ends_at: null, all_day: false, location: 'Field 3', assignee_id: null, ...over }]);
    await runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('grocery_items')).toEqual([]);
    expect(db.table('autopilot_suggestions').filter((r) => r.status === 'auto_executed')).toEqual([]);
  });
});

describe('a birthday card never reveals which wish was bought', () => {
  async function detailFor(bikeBought: boolean) {
    const db = scanDb();
    db.seed('family_members', [{ id: 'liam', family_id: FAMILY, display_name: 'Liam', birthday: '2015-09-24', is_active: true }]);
    db.seed('wishlist_items', [
      { id: 'w1', family_id: FAMILY, member_id: 'liam', title: 'Bike', priority: 'high', is_purchased: bikeBought },
      { id: 'w2', family_id: FAMILY, member_id: 'liam', title: 'Ball', priority: 'medium', is_purchased: false },
      { id: 'w3', family_id: FAMILY, member_id: 'liam', title: 'Book', priority: 'low', is_purchased: false },
      { id: 'w4', family_id: FAMILY, member_id: 'liam', title: 'Kite', priority: 'low', is_purchased: false },
    ]);
    await runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    const card = db.table('autopilot_suggestions').find((r) => r.kind === 'birthday');
    return { detail: String(card?.detail), payload: card?.payload };
  }

  it('lists the same gift ideas whether or not the top wish has been bought', async () => {
    const unbought = await detailFor(false);
    const bought = await detailFor(true);
    expect(bought.detail).toContain('Bike');
    expect(bought).toEqual(unbought);
  });
});

describe('a busy family scan respects every prior key, however many there are', () => {
  it('does not re-insert (and fail on) a prior key beyond the first 500 rows', async () => {
    const db = scanDb();
    db.seed('renewals', [{ id: 'r1', family_id: FAMILY, title: 'Passport', status: 'active', expires_at: '2026-09-23' }]);
    db.seed('autopilot_suggestions', [
      ...Array.from({ length: 600 }, (_, i) => ({ id: `old-${String(i).padStart(4, '0')}`, family_id: FAMILY, kind: 'chore', status: 'executed', title: 't', dedupe_key: `chore:${i}`, confidence: 74, urgency: 2 })),
      { id: 'zz-prior', family_id: FAMILY, kind: 'document', status: 'executed', title: 'Passport', dedupe_key: 'renewal:r1:2026-09-23', confidence: 95, urgency: 3 },
    ]);
    await expect(runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'))).resolves.toMatchObject({ autoExecuted: 0 });
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('autopilot_suggestions').filter((r) => r.dedupe_key === 'renewal:r1:2026-09-23')).toHaveLength(1);
  });

  it('treats a key a concurrent scan already wrote as a prior row, removing its own side effect', async () => {
    const db = scanDb();
    db.seed('renewals', [{ id: 'r1', family_id: FAMILY, title: 'Passport', status: 'active', expires_at: '2026-09-23' }]);
    const original = db.from.bind(db);
    let raced = false;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      const query = original(table);
      if (table === 'autopilot_suggestions' && !raced) {
        const insert = query.insert.bind(query);
        query.insert = (rows) => {
          raced = true;
          db.seed('autopilot_suggestions', [{ family_id: FAMILY, kind: 'document', status: 'open', title: 'Passport', dedupe_key: 'renewal:r1:2026-09-23', confidence: 95, urgency: 3 }]);
          return insert(rows);
        };
      }
      return query;
    });
    await expect(runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'))).resolves.toMatchObject({ autoExecuted: 0 });
    expect(db.table('reminders')).toEqual([]);
  });
});

describe('an auto-created reminder is one the notifier can still deliver', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata'])('%s: renewal and overdue refill land in the future', async (tz) => {
    const db = scanDb();
    const now = new Date('2026-09-21T06:30:00Z');
    const today = wallDay(now.toISOString(), tz);
    const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    db.seed('renewals', [{ id: 'r1', family_id: FAMILY, title: 'Passport', status: 'active', expires_at: plus(2) }]);
    db.seed('medications', [{ id: 'm1', family_id: FAMILY, name: 'Inhaler', member_id: null, refill_on: plus(-1), refill_reminder_days: 3, is_active: true }]);
    await runAutopilotScan(db, FAMILY, 'u1', tz, 'en-US', echo, now);
    const reminders = db.table('reminders');
    expect(reminders).toHaveLength(2);
    for (const r of reminders) expect(Date.parse(String(r.remind_at)), String(r.title)).toBeGreaterThan(now.getTime());
  });

  it('keeps an instant still ahead and moves a past one to the next family 09:00', () => {
    const now = new Date('2026-09-21T06:30:00Z');
    expect(deliverableReminderIso('2026-09-21T16:00:00Z', now, 'UTC')).toBe('2026-09-21T16:00:00Z');
    // 15:30 in Tokyo: today's 09:00 has gone, tomorrow's is 00:00Z on the 22nd.
    expect(deliverableReminderIso('2026-09-21T00:00:00Z', now, 'Asia/Tokyo')).toBe('2026-09-22T00:00:00.000Z');
  });
});

describe('renewal and insurance cards', () => {
  it('a renewal reminder is set three days before the lapse, not for now', () => {
    const [draft] = renewalSuggestions(snapshot({ renewals: [{ id: 'r1', label: 'Passport', expiresOn: '2026-10-11' }] }));
    expect(draft.payload.at).toBe('2026-10-08T09:00:00.000Z');
    expect(draft.payload).not.toHaveProperty('remindOffsetDays');
    const [soon] = renewalSuggestions(snapshot({ renewals: [{ id: 'r2', label: 'Visa', expiresOn: '2026-09-22' }] }));
    expect(soon.payload.at).toBe('2026-09-21T09:00:00.000Z');
  });

  it.each(['America/Los_Angeles', 'Asia/Tokyo', 'UTC'])('%s: a card due today stays acceptable until the family\'s midnight', (tz) => {
    const s = snapshot({ tz, renewals: [{ id: 'r1', label: 'Passport', expiresOn: '2026-09-21' }], insurance: [{ id: 'p1', label: 'Home insurance', renewalOn: '2026-09-21' }] });
    for (const draft of [...renewalSuggestions(s), ...insuranceSuggestions(s)]) {
      const end = Date.parse(String(draft.expiresAt));
      expect(wallDay(new Date(end).toISOString(), tz)).toBe('2026-09-21');
      expect(wallDay(new Date(end + 1).toISOString(), tz)).toBe('2026-09-22');
    }
  });
});

describe('accepting a reminder card re-checks the row it was built from', () => {
  const USER = 'u1';
  const MEMBER = 'm1';
  const AT = '2026-09-21T10:00:00.000Z';
  const STARTS = '2026-09-22T15:00:00.000Z';
  let db: InMemorySupabase;
  let scope: ServiceScope;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = new InMemorySupabase({ userId: USER, uniques: { family_reminders: [['family_id', 'idempotency_key']] } });
    db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true }]);
    db.seed('appointments', [{ id: 'appt-1', family_id: FAMILY, title: 'Dentist', starts_at: STARTS, member_id: null }]);
    db.seed('autopilot_suggestions', [{
      id: 'sug-1', family_id: FAMILY, kind: 'appointment', action_type: 'create_reminder', status: 'open',
      title: 'Dentist is tomorrow', detail: 'No reminder is set yet — want one?', payload: { title: 'Dentist', at: STARTS },
      member_id: null, urgency: 2, updated_at: AT, expires_at: null, source_kind: 'appointments', source_id: 'appt-1',
      dedupe_key: 'appt:appt-1:2026-09-22',
    }]);
    scope = { db: db as unknown as ServiceScope['db'], userId: USER, memberId: MEMBER, familyId: FAMILY, role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(AT) };
  });
  const accept = () => resolveSuggestion(scope, { suggestionId: 'sug-1', updatedAt: AT, action: 'reminder' });

  it('creates the reminder while the appointment is unchanged (control)', async () => {
    expect(await accept()).toMatchObject({ ok: true, status: 'executed' });
    expect(db.table('family_reminders')).toHaveLength(1);
  });

  it.each([
    { label: 'cancelled', change: (d: InMemorySupabase) => d.replace('appointments', []) },
    { label: 'moved', change: (d: InMemorySupabase) => { d.table('appointments')[0].starts_at = '2026-09-25T15:00:00.000Z'; } },
    { label: 'already reminded', change: (d: InMemorySupabase) => d.seed('reminders', [{ family_id: FAMILY, related_type: 'appointment', related_id: 'appt-1', is_done: false, title: 'Dentist', remind_at: STARTS }]) },
  ])('refuses as changed when the appointment was $label', async ({ change }) => {
    change(db);
    expect(await accept()).toEqual({ ok: false, code: 'changed' });
    expect(db.table('family_reminders')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('a past payload time becomes a reminder that can still fire', async () => {
    db.table('autopilot_suggestions')[0].source_kind = null;
    db.table('autopilot_suggestions')[0].payload = { title: 'Refill', at: '2026-09-21T09:00:00Z' };
    expect(await accept()).toMatchObject({ ok: true, status: 'executed' });
    expect(Date.parse(String(db.table('family_reminders')[0].remind_at))).toBeGreaterThan(Date.parse(AT));
  });
});
