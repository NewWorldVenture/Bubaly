// The reminder buttons that never saved anything now save through the service.
//
// The companion to `reminder-status-constraint.test.ts`: that file holds the
// class shut by reading the migration, this one drives the real service to show
// what the row actually looks like — a legal `status`, and a `priority` the
// caller's `'normal'` is mapped onto rather than sent on to a CHECK that would
// reject the whole row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { createReminderAction } from '@/app/(app)/dashboard/reminders/actions';

const FAMILY = 'family-1';
const TAP_ONE = '11111111-1111-4111-8111-111111111111';
const TAP_TWO = '22222222-2222-4222-8222-222222222222';

/** 0014's CHECK sets, restated here ONLY as the assertion's expectation. The
 *  constraint itself is read from the migration in the companion file. */
const LEGAL_STATUS = ['active', 'snoozed', 'completed', 'dismissed'];
const LEGAL_PRIORITY = ['low', 'medium', 'high', 'urgent'];

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const reminders = () => db.table('family_reminders').filter((r) => r.family_id === FAMILY);

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_reminders: {
        notes: null, kind: 'time', remind_at: null, location_name: null,
        recurrence: 'none', priority: 'medium', status: 'active',
        member_id: null, assigned_to_id: null, ai_suggested: false,
        tags: [], idempotency_key: null, completed_at: null, snoozed_until: null,
      },
    },
    uniques: { family_reminders: [['family_id', 'idempotency_key']] },
  });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

const fromACall = {
  title: 'Call the dentist back about Maya',
  notes: 'From call with Dr Ruiz',
  kind: 'task',
  aiSuggested: true,
};

describe('the row a one-tap button now writes', () => {
  it('lands, with a status and priority the constraint allows', async () => {
    // Before this tranche the same tap sent status 'pending' and priority
    // 'normal', Postgres rejected the row, and the family got an error toast.
    const result = await createReminderAction({ ...fromACall, priority: 'medium', submissionId: TAP_ONE });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(reminders()).toHaveLength(1);
    expect(LEGAL_STATUS).toContain(reminders()[0]!.status);
    expect(LEGAL_PRIORITY).toContain(reminders()[0]!.priority);
  });

  it.each(['normal', 'pending', 'catastrophic', ''])('maps the illegal priority %j onto a legal one', async (priority) => {
    // The service drops an unrecognised priority rather than forwarding it. That
    // single guard is why the assistant's reminders always worked while every
    // one-tap button did not.
    const result = await createReminderAction({ ...fromACall, priority, submissionId: TAP_ONE });
    expect(result.ok).toBe(true);
    expect(LEGAL_PRIORITY).toContain(reminders()[0]!.priority);
  });

  it('keeps a priority that is already legal', async () => {
    await createReminderAction({ ...fromACall, priority: 'high', submissionId: TAP_ONE });
    expect(reminders()[0]!.priority).toBe('high');
  });

  it('takes family_id and created_by from the session', async () => {
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    expect(reminders()[0]!.family_id).toBe(FAMILY);
    // family_reminders.created_by references auth.users (0014) — not the
    // family_members id todo_items uses. Each service resolves this per column.
    expect(reminders()[0]!.created_by).toBe('user-1');
  });

  it('marks it as Bubaly-suggested when the caller says so', async () => {
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    expect(reminders()[0]!.ai_suggested).toBe(true);
  });
});

describe('a reminder with no time', () => {
  it('gets one, because a timeless reminder never fires', async () => {
    // `listDue` filters `remind_at is not null`, so storing a reminder with no
    // time stores a dud that is silently never due. The service refuses it; the
    // action picks a moment rather than refusing the family's tap.
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    const at = reminders()[0]!.remind_at as string;
    expect(at, 'a real instant, not null').toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(at))).toBe(true);
  });

  it('lands at 9am in the FAMILY’s zone, not the server’s', async () => {
    // The context above says America/New_York. 09:00 there is 13:00Z (EDT) or
    // 14:00Z (EST) — never 09:00Z, which is what resolving against the server
    // would give on a UTC host.
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    const at = new Date(reminders()[0]!.remind_at as string);
    const hourInNewYork = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hour12: false,
    }).format(at);
    expect(Number.parseInt(hourInNewYork, 10) % 24).toBe(9);
  });

  it('is in the future, so the family is not interrupted this second', async () => {
    // `now` would be the wrong pick: a reminder made from an action item is not
    // something to be pinged about immediately.
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    expect(Date.parse(reminders()[0]!.remind_at as string)).toBeGreaterThan(Date.now());
  });

  it('keeps a time the caller did give', async () => {
    // Autopilot supplies one from the suggestion payload; it must survive.
    const at = '2026-09-20T15:30:00.000Z';
    await createReminderAction({ ...fromACall, remindAt: at, submissionId: TAP_ONE });
    expect(reminders()[0]!.remind_at).toBe(at);
  });
});

describe('a tap that happens twice', () => {
  it('creates one reminder when the same item is tapped again after a failure', async () => {
    const first = await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    const retry = await createReminderAction({ ...fromACall, submissionId: TAP_ONE });

    expect(first.ok && retry.ok).toBe(true);
    expect(reminders()).toHaveLength(1);
    expect(first.ok && retry.ok && retry.id).toBe(first.ok ? first.id : null);
  });

  it('creates one when both taps are in flight at once', async () => {
    const [a, b] = await Promise.all([
      createReminderAction({ ...fromACall, submissionId: TAP_ONE }),
      createReminderAction({ ...fromACall, submissionId: TAP_ONE }),
    ]);
    expect(a.ok, a.ok ? '' : a.error).toBe(true);
    expect(b.ok, b.ok ? '' : b.error).toBe(true);
    expect(reminders()).toHaveLength(1);
  });

  it('creates two when two different action items are tapped', async () => {
    await createReminderAction({ ...fromACall, submissionId: TAP_ONE });
    await createReminderAction({ ...fromACall, title: 'Pay the invoice', submissionId: TAP_TWO });
    expect(reminders()).toHaveLength(2);
  });

  it('still saves when no usable id is sent', async () => {
    await createReminderAction({ ...fromACall, submissionId: undefined });
    await createReminderAction({ ...fromACall, submissionId: 'not-a-uuid' });
    expect(reminders()).toHaveLength(2);
    expect(reminders().every((r) => r.idempotency_key === null)).toBe(true);
  });
});

describe('validation and auth', () => {
  it.each([['', 'empty'], ['   ', 'whitespace']])('refuses %j (%s) and writes nothing', async (title) => {
    const result = await createReminderAction({ title, submissionId: TAP_ONE });
    expect(result.ok).toBe(false);
    expect(reminders()).toHaveLength(0);
  });

  it('is redirected when signed out, not handed an error toast', async () => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(createReminderAction({ ...fromACall, submissionId: TAP_ONE })).rejects.toThrow('NEXT_REDIRECT');
    expect(reminders()).toHaveLength(0);
  });
});
