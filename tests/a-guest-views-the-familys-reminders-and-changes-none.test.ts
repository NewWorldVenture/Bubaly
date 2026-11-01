// A guest views the family's reminders; it does not add, snooze, complete or
// remove them.
//
// The permission matrix (supabase/seed.sql) gives a guest no create, update or
// delete on reminders, and its own assistant is refused the same writes (the
// trust engine gives a guest ['view']). The to-dos already say so in their
// actions and services (tests/a-guest-views-the-familys-tasks-and-changes-none).
// The reminders did not: `createReminderAction` and `snoozeReminderAction`
// went straight to services that never asked, and RLS on `family_reminders`
// is plain `is_family_member` with no guest-write guard (0464 guards the
// legacy `reminders` table only). So a guest could add a family reminder or
// push a parent's medication reminder out by a day.
//
// The database half, a 0464-style guard on `family_reminders`, needs a schema
// change and is not here. These drive the REAL actions and services against an
// in-memory database.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

import { createReminderAction, snoozeReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { completeReminder, createReminder, deleteReminder, snoozeReminder } from '@/lib/services/reminders';
import { scopeFromUserContext } from '@/lib/services/scope';

const FAMILY = 'family-1';
const GUEST = 'member-guest';
const PARENT = 'member-parent';
const NOT_ALLOWED = MESSAGES['actionRefusal.notAllowed'];

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const ctx = (role: string, member: string) => ({
  user: { id: `user-${member}` },
  active: { familyId: FAMILY, role, family: { name: 'Family One', timezone: 'America/New_York' }, member: { id: member } },
});
const reminder = () => db.table('family_reminders').find((row) => row.id === 'rem-1')!;
const untouched = { title: 'Give Mia her inhaler', status: 'active', snoozed_until: null, completed_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_reminders: {
        notes: null, kind: 'time', remind_at: null, location_name: null, recurrence: 'none', priority: 'medium',
        status: 'active', member_id: null, assigned_to_id: null, ai_suggested: false, tags: [],
        idempotency_key: null, completed_at: null, snoozed_until: null,
      },
    },
  });
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY }, { id: GUEST, family_id: FAMILY }]);
  db.seed('family_reminders', [{
    id: 'rem-1', family_id: FAMILY, title: 'Give Mia her inhaler', kind: 'medication', priority: 'high',
    remind_at: '2026-10-24T12:00:00.000Z', created_by: `user-${PARENT}`,
  }]);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('the reminder actions refuse a guest', () => {
  beforeEach(() => { mocks.requireUserContext.mockResolvedValue(ctx('guest', GUEST)); });

  it('a guest cannot add a reminder', async () => {
    const result = await createReminderAction({ title: 'Sneaky reminder', remindAt: '2026-10-25T09:00:00' });
    expect(result).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(db.table('family_reminders')).toHaveLength(1);
    // Answered before any read, as the to-do actions answer.
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('a guest cannot snooze a parent\'s reminder', async () => {
    const result = await snoozeReminderAction('rem-1', 1440);
    expect(result).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(reminder()).toMatchObject(untouched);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});

describe('the services refuse a guest on every path that reaches them', () => {
  const guestScope = () => scopeFromUserContext(ctx('guest', GUEST) as never, db);

  it.each([
    ['createReminder', () => createReminder(guestScope(), { title: 'Sneaky reminder', remindAt: '2026-10-25T09:00:00' })],
    ['completeReminder', () => completeReminder(guestScope(), 'rem-1')],
    ['snoozeReminder', () => snoozeReminder(guestScope(), 'rem-1', 1440)],
    ['deleteReminder', () => deleteReminder(guestScope(), 'rem-1')],
  ])('%s answers denied and writes nothing', async (_name, call) => {
    const result = await call();
    expect(result).toMatchObject({ ok: false, code: 'denied', error: NOT_ALLOWED });
    expect(db.table('family_reminders')).toHaveLength(1);
    expect(reminder()).toMatchObject(untouched);
  });
});

describe('every other role keeps the reminders it works with', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('a %s can still add one and snooze one', async (role) => {
    mocks.requireUserContext.mockResolvedValue(ctx(role, PARENT));
    expect(await createReminderAction({ title: 'Bins out', remindAt: '2026-10-25T19:00:00' })).toMatchObject({ ok: true });
    expect(await snoozeReminderAction('rem-1', 30)).toEqual({ ok: true, id: 'rem-1' });
    expect(reminder().status).toBe('snoozed');
  });
});
