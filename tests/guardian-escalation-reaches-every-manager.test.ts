// An emergency escalation is the one alert a family cannot afford to miss, and
// the route's own header says it "Notifies ALL parent members".
//
// It filtered recipients against `['owner', 'manager', 'parent']`. Two of those
// three are not roles this product has: `public.member_role` is
// ('parent','adult','teen','child','caregiver','guest'), and the manager pair
// the rest of the codebase gates on is parent + adult (`isManager`). So the
// list read as "parent, and two words that match nobody" — an `adult`
// co-parent, guardian or step-parent got no SMS, no emergency call, and was
// left out of `notified_member_ids`, which is the record of who was told.
//
// The push notification is written family-wide (`user_id: null`) and was never
// affected. This is specifically the telephony path: the channel that reaches a
// phone that is face-down in another room.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { POST } from '@/app/api/guardian/escalate/route';

const state = vi.hoisted(() => ({ db: null as unknown }));
const twilio = vi.hoisted(() => ({
  sms: [] as string[],
  calls: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: () => true,
  sendSms: async (to: string) => { twilio.sms.push(to); },
  initiateCall: async ({ to }: { to: string }) => { twilio.calls.push(to); },
}));

type DB = SupabaseClient<Database>;
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const SECRET = 'escalation-test-secret';

/** One household, one member per role, every one of them reachable by phone. */
const HOUSEHOLD = [
  { id: 'm-parent',    user_id: 'u-parent',    display_name: 'Ada',   role: 'parent' },
  { id: 'm-adult',     user_id: 'u-adult',     display_name: 'Bo',    role: 'adult' },
  { id: 'm-teen',      user_id: 'u-teen',      display_name: 'Cass',  role: 'teen' },
  { id: 'm-child',     user_id: 'u-child',     display_name: 'Dev',   role: 'child' },
  { id: 'm-caregiver', user_id: 'u-caregiver', display_name: 'Eli',   role: 'caregiver' },
  { id: 'm-guest',     user_id: 'u-guest',     display_name: 'Fin',   role: 'guest' },
];
/** A distinct, stable number per member — a collision here would make the
 *  negative controls pass for the wrong reason. */
const phoneOf = (userId: string) =>
  `+1555${String(HOUSEHOLD.findIndex((m) => m.user_id === userId)).padStart(6, '0')}`;

let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  twilio.sms.length = 0;
  twilio.calls.length = 0;
  process.env.GUARDIAN_INTERNAL_SECRET = SECRET;
  db = createInMemorySupabase<DB>({
    uniques: { guardian_callback_events: [['event_id']] },
    // 0181's column defaults. The claim insert relies on `status` defaulting to
    // 'processing', and the release keys on it; a fixture without the default
    // held a status-less row that the real table can never contain.
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('family_members', HOUSEHOLD.map((m) => ({ ...m, family_id: FAMILY, is_active: true })));
  db.seed('profiles', HOUSEHOLD.map((m) => ({ id: m.user_id, phone: phoneOf(m.user_id) })));
  state.db = db;
});

async function escalate(severity: 'critical' | 'high', commId: string) {
  return POST(new NextRequest('http://localhost/api/guardian/escalate', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      familyId: FAMILY,
      commId,
      escalationType: 'emergency_call',
      severity,
      description: 'Caller says there is smoke in the kitchen.',
      callerNumber: '+15550000000',
    }),
  }));
}

/** The member ids the route recorded as having been told. */
function notified(): string[] {
  const rows = db.table('guardian_escalations') as { notified_member_ids?: string[] }[];
  expect(rows.length, 'the escalation was not recorded at all').toBe(1);
  return [...(rows[0].notified_member_ids ?? [])].sort();
}

describe('an emergency escalation reaches every manager, not just the parent', () => {
  it('texts and calls the adult co-parent as well as the parent', async () => {
    const res = await escalate('critical', '00000000-0000-4000-8000-000000000a01');
    expect(res.status).toBe(200);

    // The defect, in one assertion: Bo is an adult, and an adult is a manager
    // everywhere else in this product.
    expect(twilio.sms.sort()).toEqual([phoneOf('u-parent'), phoneOf('u-adult')].sort());
    expect(twilio.calls.sort()).toEqual([phoneOf('u-parent'), phoneOf('u-adult')].sort());
    expect(notified()).toEqual(['m-adult', 'm-parent']);
  });

  it('still does not text the teen, the child, the caregiver or the guest', async () => {
    // The positive control. Widening the manager pair must not widen it to
    // everyone: an emergency call announcing smoke in the kitchen is not a
    // message to send a nine-year-old's phone.
    await escalate('critical', '00000000-0000-4000-8000-000000000a02');
    for (const who of ['u-teen', 'u-child', 'u-caregiver', 'u-guest']) {
      expect(twilio.sms, `${who} should not be texted`).not.toContain(phoneOf(who));
      expect(twilio.calls, `${who} should not be called`).not.toContain(phoneOf(who));
    }
  });

  it('only places the outbound call when the severity is critical', async () => {
    // The other control: a `high` escalation texts but must not ring the house.
    await escalate('high', '00000000-0000-4000-8000-000000000a03');
    expect(twilio.sms.length).toBe(2);
    expect(twilio.calls).toEqual([]);
  });

  it('skips a manager who has no phone on file rather than recording them as told', async () => {
    db.replace('profiles', HOUSEHOLD
      .filter((m) => m.user_id !== 'u-adult')
      .map((m) => ({ id: m.user_id, phone: phoneOf(m.user_id) }))
      .concat([{ id: 'u-adult', phone: null as unknown as string }]));
    await escalate('critical', '00000000-0000-4000-8000-000000000a04');
    expect(twilio.sms).toEqual([phoneOf('u-parent')]);
    expect(notified()).toEqual(['m-parent']);
  });
});

describe('a failed phone lookup is retried, not recorded as nobody to call (CALLBACK-71A417C2F077)', () => {
  it('sends nothing, leaves the claim retryable, and alerts once on the retry', async () => {
    const real = db;
    let failProfiles = true;
    state.db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table === 'profiles' && failProfiles) {
            const failing = { select: () => failing, in: async () => ({ data: null, error: { message: 'private read failure', code: '08006' } }) };
            return failing;
          }
          return target.from(table as never);
        };
      },
    });

    const commId = '00000000-0000-4000-8000-000000000a05';
    const first = await escalate('critical', commId);
    expect(first.status).toBe(500);
    expect(twilio.sms).toEqual([]);
    expect(twilio.calls).toEqual([]);
    expect(real.table('notifications')).toEqual([]);
    expect(real.table('guardian_escalations')).toEqual([]);
    // "Leaves the claim retryable" used to mean a row marked `error`, which
    // claimGuardianCallback reclaims only after ten minutes — so this test aged
    // the row by hand before retrying, and in production the caller's retry
    // inside that window was answered `{ ok: true, duplicate: true }` with
    // nobody told. Nothing has been sent at this point, so the claim is now
    // given back outright, and the retry below needs no help.
    expect(real.table('guardian_callback_events'), 'the claim was given back, not parked as an error').toEqual([]);

    failProfiles = false;
    const retry = await escalate('critical', commId);
    expect(retry.status).toBe(200);
    expect(twilio.sms.sort()).toEqual([phoneOf('u-parent'), phoneOf('u-adult')].sort());
    expect(real.table('notifications')).toHaveLength(1);
    expect(notified()).toEqual(['m-adult', 'm-parent']);
  });
});
