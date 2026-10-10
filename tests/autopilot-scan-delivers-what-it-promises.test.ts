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
import { deliverableReminderIso, draftHasLapsed, reminderIsoFor } from '@/lib/autopilot/reminder-time';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
// What the family's phones would be told. Recorded, not delivered.
const pushes = vi.hoisted(() => ({ sent: [] as { title: string; body: string | null }[] }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async (_scope: unknown, input: { title: string; body?: string | null }) => {
    pushes.sent.push({ title: input.title, body: input.body ?? null });
    return { ok: true, data: { created: 1 } };
  }),
}));
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

afterEach(() => { vi.restoreAllMocks(); pushes.sent = []; });

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

  it('a past payload time on a day-tied card (a refill) becomes a reminder that can still fire', async () => {
    db.seed('medications', [{ id: 'med-1', family_id: FAMILY, name: 'Inhaler', refill_on: '2026-09-21', is_active: true }]);
    Object.assign(db.table('autopilot_suggestions')[0], {
      kind: 'medication', source_kind: 'medications', source_id: 'med-1', dedupe_key: 'med-refill:med-1:2026-09-21',
      payload: { title: 'Refill', at: '2026-09-21T09:00:00Z' },
    });
    expect(await accept()).toMatchObject({ ok: true, status: 'executed' });
    expect(Date.parse(String(db.table('family_reminders')[0].remind_at))).toBeGreaterThan(Date.parse(AT));
  });

  it('an appointment whose time has passed is refused as changed, not moved to tomorrow morning', async () => {
    scope = { ...scope, now: new Date('2026-09-22T16:00:00.000Z') };
    expect(await accept()).toEqual({ ok: false, code: 'changed' });
    expect(db.table('family_reminders')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('a "leave by" whose time has passed is refused as changed, though the event is still ahead', async () => {
    const eventStart = '2026-09-21T18:00:00.000Z';
    db.seed('calendar_events', [{ id: 'ev-1', family_id: FAMILY, title: 'Soccer', starts_at: eventStart }]);
    Object.assign(db.table('autopilot_suggestions')[0], {
      kind: 'moment', source_kind: 'calendar_events', source_id: 'ev-1', dedupe_key: 'moment-leaveby:ev-1:2026-09-21',
      title: 'Leave on time for Soccer', payload: { title: 'Leave for Soccer', at: '2026-09-21T17:30:00.000Z' }, expires_at: eventStart,
    });
    scope = { ...scope, now: new Date('2026-09-21T17:45:00.000Z') };
    expect(await accept()).toEqual({ ok: false, code: 'changed' });
    expect(db.table('family_reminders')).toEqual([]);
    // Control: before the leave-by, the same card is a reminder at the leave-by.
    scope = { ...scope, now: new Date('2026-09-21T15:00:00.000Z') };
    expect(await accept()).toMatchObject({ ok: true, status: 'executed' });
    expect(db.table('family_reminders')[0].remind_at).toBe('2026-09-21T17:30:00.000Z');
  });
});

describe('an event-tied reminder whose moment has passed is not created, moved or announced', () => {
  const LA = 'America/Los_Angeles';
  // 11:00 Los Angeles on 2026-09-21 is 18:00Z; noon is 19:00Z.
  const soccer = (startsAt: string) => ({ id: 'e1', family_id: FAMILY, title: 'Soccer game', starts_at: startsAt, ends_at: null, all_day: false, location: 'Field 3', assignee_id: null });
  const leaveByFor = (startsAt: string) => momentPrepSuggestions(snapshot({ tz: LA, events: [{ id: 'e1', title: 'Soccer game', startsAt, endsAt: null, memberId: null, allDay: false, location: 'Field 3' }] }))
    .find((d) => d.dedupeKey.startsWith('moment-leaveby:'));

  it('the reviewer\u2019s case: an 11:00 game scanned at noon makes no "Leave for" reminder for tomorrow 09:00, and no push', async () => {
    const db = scanDb();
    db.seed('families', [{ id: FAMILY, timezone: LA }]);
    db.seed('calendar_events', [soccer('2026-09-21T18:00:00Z')]);
    await runAutopilotScan(db, FAMILY, 'u1', LA, 'en-US', echo, new Date('2026-09-21T19:00:00Z'));
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('autopilot_suggestions').filter((r) => String(r.dedupe_key).startsWith('moment-'))).toEqual([]);
    expect(pushes.sent.filter((p) => p.title.startsWith('Autopilot handled'))).toEqual([]);
  });

  it('a game still ahead whose leave-by has gone is skipped too (expiry alone would keep it)', async () => {
    const start = '2026-09-21T18:00:00Z';
    const leaveBy = String(leaveByFor(start)?.payload.at);
    expect(Date.parse(leaveBy)).toBeLessThan(Date.parse(start));
    const now = new Date(Math.round((Date.parse(leaveBy) + Date.parse(start)) / 2));
    const db = scanDb();
    db.seed('families', [{ id: FAMILY, timezone: LA }]);
    db.seed('calendar_events', [soccer(start)]);
    await runAutopilotScan(db, FAMILY, 'u1', LA, 'en-US', echo, now);
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('autopilot_suggestions').filter((r) => String(r.dedupe_key).startsWith('moment-leaveby:'))).toEqual([]);
    expect(pushes.sent.filter((p) => p.title.includes('Leave'))).toEqual([]);
  });

  it('control: scanned before the leave-by, the reminder is set at the leave-by and announced', async () => {
    const start = '2026-09-21T18:00:00Z';
    const leaveBy = String(leaveByFor(start)?.payload.at);
    const db = scanDb();
    db.seed('families', [{ id: FAMILY, timezone: LA }]);
    db.seed('calendar_events', [soccer(start)]);
    await runAutopilotScan(db, FAMILY, 'u1', LA, 'en-US', echo, new Date('2026-09-21T13:30:00Z'));
    expect(db.table('reminders').map((r) => r.remind_at)).toEqual([leaveBy]);
    expect(pushes.sent.map((p) => p.title)).toContain('Autopilot handled: Leave on time for Soccer game');
  });

  it('an appointment earlier today is not offered once its time has passed', async () => {
    const db = scanDb();
    db.seed('appointments', [{ id: 'a1', family_id: FAMILY, title: 'Dentist', starts_at: '2026-09-21T08:00:00Z', member_id: null }]);
    await runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T10:00:00Z'));
    expect(db.table('autopilot_suggestions').filter((r) => r.kind === 'appointment')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
  });

  it('any draft whose card has already expired is skipped: an afternoon clash scanned that evening', async () => {
    // 15:00 and 15:30 Los Angeles (22:00Z / 22:30Z); the clash card expires at
    // 23:59:59Z, so at 18:00 Los Angeles (01:00Z next day) it has gone.
    const db = scanDb();
    db.seed('calendar_events', [
      { id: 'c1', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-21T22:00:00Z', ends_at: '2026-09-21T23:00:00Z', all_day: false, location: null, assignee_id: null },
      { id: 'c2', family_id: FAMILY, title: 'Swim', starts_at: '2026-09-21T22:30:00Z', ends_at: '2026-09-21T23:30:00Z', all_day: false, location: null, assignee_id: null },
    ]);
    await runAutopilotScan(db, FAMILY, 'u1', LA, 'en-US', echo, new Date('2026-09-22T01:00:00Z'));
    expect(db.table('autopilot_suggestions').filter((r) => r.kind === 'conflict')).toEqual([]);
    // Control: the same clash scanned at noon is offered.
    await runAutopilotScan(db, FAMILY, 'u1', LA, 'en-US', echo, new Date('2026-09-21T19:00:00Z'));
    expect(db.table('autopilot_suggestions').filter((r) => r.kind === 'conflict')).toHaveLength(1);
  });

  it('only day-tied sources move to the next family 09:00', () => {
    const now = new Date('2026-09-21T19:00:00Z');
    const past = '2026-09-21T17:30:00Z';
    expect(reminderIsoFor('calendar_events', past, now, LA)).toBeNull();
    expect(reminderIsoFor('appointments', past, now, LA)).toBeNull();
    for (const kind of ['renewals', 'family_insurance_policies', 'medications', null]) {
      expect(reminderIsoFor(kind, past, now, LA)).toBe('2026-09-22T16:00:00.000Z');
    }
    expect(reminderIsoFor('calendar_events', '2026-09-21T20:00:00Z', now, LA)).toBe('2026-09-21T20:00:00Z');
    // An expired card has no reminder, whatever it is about.
    expect(reminderIsoFor('medications', past, now, LA, '2026-09-21T18:00:00Z')).toBeNull();
    expect(draftHasLapsed({ sourceKind: 'medications', actionType: 'create_reminder', payload: { at: past }, expiresAt: null }, now, LA)).toBe(false);
    expect(draftHasLapsed({ sourceKind: 'calendar_events', actionType: 'create_reminder', payload: { at: past }, expiresAt: null }, now, LA)).toBe(true);
    expect(draftHasLapsed({ sourceKind: 'grocery_items', actionType: 'keep_grocery', payload: {}, expiresAt: '2026-09-21T18:59:59Z' }, now, LA)).toBe(true);
  });
});

describe('a feed\u2019s event titles never reach every member\u2019s push', () => {
  it('a clash with an imported event is announced without its title, and stored as one plain line', async () => {
    const db = scanDb();
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    db.seed('calendar_events', [
      { id: 'x1', family_id: FAMILY, title: 'Prize!\n\nCall 555-0100 <<<now>>>', starts_at: '2026-09-21T15:00:00Z', ends_at: '2026-09-21T16:00:00Z', all_day: false, location: null, assignee_id: null, feed_id: 'feed-1' },
      { id: 'x2', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-21T15:30:00Z', ends_at: '2026-09-21T16:30:00Z', all_day: false, location: null, assignee_id: null },
    ]);
    await runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    const card = db.table('autopilot_suggestions').find((r) => r.kind === 'conflict');
    expect(card).toBeTruthy();
    expect(String(card?.title)).not.toMatch(/\n|<<<|>>>/);
    const clash = pushes.sent.filter((p) => p.title.startsWith('Schedule clash'));
    expect(clash).toEqual([{ title: 'Schedule clash: two events overlap', body: expect.any(String) }]);
    for (const p of pushes.sent) expect(p.title).not.toContain('555-0100');
  });

  it('control: a clash between the family\u2019s own events still names them', async () => {
    const db = scanDb();
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    db.seed('calendar_events', [
      { id: 'x1', family_id: FAMILY, title: 'Swim', starts_at: '2026-09-21T15:00:00Z', ends_at: '2026-09-21T16:00:00Z', all_day: false, location: null, assignee_id: null },
      { id: 'x2', family_id: FAMILY, title: 'Piano', starts_at: '2026-09-21T15:30:00Z', ends_at: '2026-09-21T16:30:00Z', all_day: false, location: null, assignee_id: null },
    ]);
    await runAutopilotScan(db, FAMILY, 'u1', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    expect(pushes.sent.map((p) => p.title)).toContain('Schedule clash: "Swim" overlaps "Piano"');
  });
});
