// The School & Sports desk's Propose, called the way the desk calls it, by
// every household role, with a message of the caller's family and with one of
// another family.
//
// THE POLICY, from the sources rather than from the action:
//   - Filing the household's front-desk mail is a parent's or adult's act:
//     `mayFile` in lib/services/inbox/index.ts:46 (isManager, or the system),
//     which the action applies before anything is read
//     (app/(app)/dashboard/school/actions.ts, "Filing the household's
//     front-desk mail is a manager's act"); isManager in lib/constants/roles.ts.
//   - A guest is withheld the household inbox and the AI Front Desk
//     (lib/auth/guest-scope.ts GUEST_WITHHELD_PREFIXES: /dashboard/inbox,
//     /dashboard/front-desk), so a guest's Propose is refused too.
//   - A proposal is a question, never an act: it files one pending approval and
//     leaves the message unhandled (the action's header).
//   - A message is read for the caller's own family only
//     (`loadInboxMessage`, `.eq('family_id', scope.familyId)`); another
//     family's id is "no longer in the inbox".
//
// Mocked: the session, the server client factory, next/cache, the translator
// (the real en-US source catalogue) and the run kicker. The inbox, school and
// sports services, the classifier and the trust gate run for real against the
// in-memory client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  CALLERS, FAMILY_A, FAMILY_B, memberIdOf, memberRows, type Caller,
} from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: vi.fn() }));

const { proposeFrontDeskAction } = await import('@/app/(app)/dashboard/school/actions');

const MSG_A = 'a0000000-0000-4000-8000-0000000d0001';
const MSG_B = 'b0000000-0000-4000-8000-0000000d0001';
const PARENTS_ONLY = 'Only a parent or adult can file a family message.';
const NOT_IN_INBOX = 'That message is no longer in the inbox.';

const MANAGERS: Caller[] = ['parent', 'adult'];
/** Every caller who is not a parent or adult, the kid login and the guest among them. */
const REFUSED: Caller[] = CALLERS.filter((c) => !MANAGERS.includes(c));

let db: InMemorySupabase;
const approvals = () => db.table('approval_requests');
const messages = () => structuredClone(db.table('family_inbox_messages'));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    defaults: {
      approval_requests: { approvals: [], expires_at: null, run_id: null, plan_step_id: null, plan_step_ids: [], payload_kind: null, request_id: null },
    },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  harness.db = db;
  harness.caller = 'parent';
  harness.revalidatePath = [];
  db.seed('family_members', [...memberRows(FAMILY_A), ...memberRows(FAMILY_B)]);
  db.seed('family_ai_settings', [
    { family_id: FAMILY_A, enabled: true, behavior: 'execute' },
    { family_id: FAMILY_B, enabled: true, behavior: 'execute' },
  ]);
  const slip = { subject: 'School permission slip', body: 'Please sign and return the school permission slip by September 15, 2026.', ai_handled: false, status: 'new' };
  db.seed('family_inbox_messages', [
    { id: MSG_A, family_id: FAMILY_A, ...slip },
    { id: MSG_B, family_id: FAMILY_B, ...slip },
  ]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('proposeFrontDeskAction (ACTION-949C04ABC5DB)', () => {
  it.each(MANAGERS)('ACTION-949C04ABC5DB a %s files one pending approval in their own family and leaves the message unhandled', async (caller) => {
    as(caller);
    const before = messages();
    const result = await proposeFrontDeskAction(MSG_A);

    expect(approvals()).toEqual([expect.objectContaining({
      family_id: FAMILY_A,
      status: 'pending',
      requested_by_member_id: memberIdOf(caller),
      payload: expect.objectContaining({ source: { kind: 'school_front_desk', message_id: MSG_A } }),
    })]);
    expect(result).toEqual({ ok: true, outcome: 'pending_approval', approvalId: approvals()[0].id, reason: expect.any(String) });
    // Nothing executed and nothing filed: both families' messages are as they were.
    expect(messages()).toEqual(before);
    expect(db.table('family_reminders')).toEqual([]);
    expect(harness.revalidatePath).toEqual(['/dashboard/school']);
  });

  it.each(REFUSED)('ACTION-949C04ABC5DB a %s is told only a parent or adult files it, and nothing is written', async (caller) => {
    as(caller);
    const before = messages();

    expect(await proposeFrontDeskAction(MSG_A)).toEqual({ ok: false, error: PARENTS_ONLY, code: 'denied' });
    expect(approvals()).toEqual([]);
    expect(db.table('family_reminders')).toEqual([]);
    expect(messages()).toEqual(before);
    expect(harness.revalidatePath).toEqual([]);
  });

  it.each(MANAGERS)("ACTION-949C04ABC5DB another family's message is not in a %s's inbox, and neither family changes", async (caller) => {
    as(caller);
    const before = messages();

    expect(await proposeFrontDeskAction(MSG_B)).toEqual({ ok: false, error: NOT_IN_INBOX, code: 'not_found' });
    expect(approvals()).toEqual([]);
    expect(messages()).toEqual(before);
  });

  it('ACTION-949C04ABC5DB a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = messages();
    await expect(proposeFrontDeskAction(MSG_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(approvals()).toEqual([]);
    expect(messages()).toEqual(before);
  });
});
