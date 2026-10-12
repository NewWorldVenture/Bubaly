// Bounded source/tool contract diagnostic. The table model has no RLS or real Auth.
//
// The coordinator's six cases (comment 6133917297 on PR #1031): a reminder an
// Autopilot card made is listed only to the card's readers
// (lib/autopilot/reminder-cards.ts), but the reminder tools took an explicit
// `reminder_id` straight to completeReminder / snoozeReminder, which scoped by
// id and family alone. A teen the insurance policy does not name, never
// listed "Synthetic private policy reminder", completed or snoozed it by id
// through the real dispatcher (its low-risk scheduling edit admitted by the
// teen risk tier) and was read its title back.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
// The reminders page's server actions, run as the signed-in member `actions.as` names.
const actions = vi.hoisted(() => ({ as: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => actions.as }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { executeTool } from '@/lib/ai/tools/execute';
import { getTool } from '@/lib/ai/tools/registry';
import { evaluateTrust } from '@/lib/trust/server';
import { riskToDecision } from '@/lib/trust/engine';
import { reminderCardsReader, visibleReminders } from '@/lib/autopilot/reminder-cards';
import { mintSuggestionReminderKey, mintSuggestionSourceTag } from '@/lib/autopilot/reminder-key';
import { completeReminder, deleteReminder, snoozeReminder } from '@/lib/services/reminders';
import { deleteReminderAction, snoozeReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { parseVerificationSpec, runVerification } from '@/lib/ai/runs/verify';

const FAMILY = '00000000-0000-4000-8000-00000000e001';
const OTHER = '00000000-0000-4000-8000-00000000e002';
const TEEN = '00000000-0000-4000-8000-00000000e003';
const USER = '00000000-0000-4000-8000-00000000e004';
const PARENT = '00000000-0000-4000-8000-00000000e005';
const NOW = '2026-10-12T12:00:00.000Z';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

type LinkedRow = Record<string, unknown> & { id: string; related_type: string | null; related_id: string | null; tags: string[]; idempotency_key: string | null };

const scope = (): ServiceScope => ({ db, familyId: FAMILY, userId: USER, memberId: TEEN, role: 'teen', actorKind: 'ai', tz: 'UTC', now: new Date(NOW) });
const snapshot = () => JSON.parse(JSON.stringify(db.table('family_reminders'))) as Record<string, unknown>[];
function personal(id: string, familyId = FAMILY): Record<string, unknown> {
  return { id, family_id: familyId, title: 'Synthetic personal reminder', remind_at: '2026-10-13T12:00:00.000Z', recurrence: 'none', status: 'active', priority: 'medium', member_id: TEEN, tags: [], related_type: null, related_id: null, idempotency_key: null };
}
async function cardReminder(named: boolean): Promise<void> {
  const card = { id: '00000000-0000-4000-8000-00000000e010', family_id: FAMILY, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: '00000000-0000-4000-8000-00000000e011', member_id: named ? TEEN : PARENT, action_type: 'create_reminder', title: 'Synthetic private policy reminder', detail: 'Synthetic private policy detail', urgency: 60, payload: { title: 'Synthetic private policy reminder' } };
  const idempotency_key = await mintSuggestionReminderKey(FAMILY, card.id);
  const stamp = await mintSuggestionSourceTag(card);
  expect(idempotency_key).toMatch(/^[a-f0-9]{64}$/);
  expect(stamp).toMatch(/^autopilot-source:[a-f0-9]{64}$/);
  db.seed('autopilot_suggestions', [card]);
  db.seed('family_reminders', [{ ...personal('insurance-reminder'), title: card.title, member_id: null, idempotency_key, tags: [stamp] }]);
}
/** What the teen's reminder lists show: the reader's rule over every row of the family's. */
async function eligible(): Promise<string[]> {
  const reply = await db.from('family_reminders').select('*').eq('family_id', FAMILY).order('remind_at').order('id');
  expect(reply.error).toBeNull();
  const rows = (reply.data ?? []) as LinkedRow[];
  const kept = await visibleReminders(rows, { role: 'teen', memberId: TEEN },
    reminderCardsReader(db, FAMILY, { onError: error => { throw error; }, keyOf: id => mintSuggestionReminderKey(FAMILY, id), sourceTagOf: mintSuggestionSourceTag }));
  return kept.map(row => String(row.id));
}
async function admission(): Promise<unknown> {
  for (const name of ['reminders.complete', 'reminders.snooze']) expect(getTool(name)).toMatchObject({ name, domain: 'scheduling', capability: 'edit', risk: 'low', readOnly: false });
  const trust = await evaluateTrust(db, FAMILY, { actor: { kind: 'ai_agent', id: 'bubaly', role: 'teen' }, onBehalfOfMemberId: TEEN, domain: 'scheduling', capability: 'automate', openApproval: false });
  expect(trust.decision).toMatchObject({ effect: 'deny', basis: 'fallback' });
  expect(trust.approvalId).toBeUndefined();
  const tier = riskToDecision({ risk: 'low', actor: { kind: 'ai_agent', id: 'bubaly', role: 'teen' }, domain: 'scheduling', capability: 'automate', behavior: 'execute', explicitAllow: false });
  expect(tier).toMatchObject({ effect: 'allow', basis: 'risk_tier' });
  return { trust, tier };
}
async function dispatch(label: string, name: string, id: string): Promise<Awaited<ReturnType<typeof executeTool>>> {
  await admission();
  await eligible();
  const previousReceiptIds = new Set(db.table('ai_tool_calls').map(row => row.id));
  const outcome = await executeTool(scope(), name, { reminder_id: id, ...(name === 'reminders.snooze' ? { minutes: 30 } : {}) });
  expect(db.table('approval_requests'), label).toHaveLength(0);
  expect(db.table('trust_audit_logs').some(row => row.decision === 'allow' && (row.context as { basis?: string } | null)?.basis === 'risk_tier'), label).toBe(true);
  const newReceipts = db.table('ai_tool_calls').filter(row => !previousReceiptIds.has(row.id));
  expect(newReceipts, label).toHaveLength(1);
  expect(newReceipts[0], label).toMatchObject({ id: outcome.toolCallId, family_id: FAMILY, tool_name: name, requested_by: USER, requested_by_member_id: TEEN });
  return outcome;
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] }, defaults: { ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null }, agent_activity: { id: 'activity' } } }) as DB;
  holder.db = db;
  db.seed('family_members', [{ id: TEEN, family_id: FAMILY, user_id: USER, role: 'teen', is_active: true }]);
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true }]);
});

describe('explicit reminder IDs honor the card audience through the real dispatcher', () => {
  it('admits a teen completing an own personal reminder', async () => {
    db.seed('family_reminders', [personal('personal-complete')]);
    expect(await eligible()).toContain('personal-complete');
    const outcome = await dispatch('own-complete', 'reminders.complete', 'personal-complete');
    expect(outcome).toMatchObject({ status: 'ok', data: { id: 'personal-complete', status: 'completed' } });
    expect(db.table('ai_tool_calls')[0].state).toBe('succeeded');
  });
  it('admits a teen snoozing an own personal reminder', async () => {
    db.seed('family_reminders', [personal('personal-snooze')]);
    expect(await eligible()).toContain('personal-snooze');
    const outcome = await dispatch('own-snooze', 'reminders.snooze', 'personal-snooze');
    expect(outcome).toMatchObject({ status: 'ok', data: { id: 'personal-snooze', status: 'snoozed' } });
    expect(db.table('ai_tool_calls')[0].state).toBe('succeeded');
  });
  it('refuses a nonnamed teen completing a hidden insurance reminder by ID', async () => {
    await cardReminder(false);
    expect(await eligible()).not.toContain('insurance-reminder');
    const before = snapshot();
    const outcome = await dispatch('hidden-complete', 'reminders.complete', 'insurance-reminder');
    expect(snapshot()).toEqual(before);
    expect(outcome.status).not.toBe('ok');
    expect(JSON.stringify(outcome)).not.toContain('Synthetic private policy reminder');
  });
  it('refuses a nonnamed teen snoozing a hidden insurance reminder by ID', async () => {
    await cardReminder(false);
    expect(await eligible()).not.toContain('insurance-reminder');
    const before = snapshot();
    const outcome = await dispatch('hidden-snooze', 'reminders.snooze', 'insurance-reminder');
    expect(snapshot()).toEqual(before);
    expect(outcome.status).not.toBe('ok');
    expect(JSON.stringify(outcome)).not.toContain('Synthetic private policy reminder');
  });
  it('admits the named teen for both insurance reminder operations', async () => {
    await cardReminder(true);
    expect(await eligible()).toContain('insurance-reminder');
    expect(await dispatch('named-complete', 'reminders.complete', 'insurance-reminder')).toMatchObject({ status: 'ok' });
    expect(await eligible()).toContain('insurance-reminder');
    expect(await dispatch('named-snooze', 'reminders.snooze', 'insurance-reminder')).toMatchObject({ status: 'ok' });
  });
  it('refuses foreign-family IDs for both operations without changing their rows', async () => {
    db.seed('family_reminders', [personal('foreign-reminder', OTHER)]);
    expect(await eligible()).not.toContain('foreign-reminder');
    const before = snapshot();
    expect((await dispatch('foreign-complete', 'reminders.complete', 'foreign-reminder')).status).not.toBe('ok');
    expect(snapshot()).toEqual(before);
    expect((await dispatch('foreign-snooze', 'reminders.snooze', 'foreign-reminder')).status).not.toBe('ok');
    expect(snapshot()).toEqual(before);
  });
});

// ─── Beyond the six: every entrypoint that acts on ONE reminder by its id ────
//
// The guard is lib/services/reminders/shown.ts, asked by completeReminder,
// snoozeReminder and deleteReminder before their write — so the assistant's
// tools (by id or by title), the reminders page's snooze and remove, an
// approved or planned replay and the life-events undo all reach it — and by a
// run's `fields_match` verification of a reminder.

const TITLE = 'Synthetic private policy reminder';
const DETAIL = 'Synthetic private policy detail';
const UNKNOWN = 'no-such-reminder';
const GUEST = '00000000-0000-4000-8000-00000000e006';
const PARENT_USER = '00000000-0000-4000-8000-00000000e007';
const GUEST_USER = '00000000-0000-4000-8000-00000000e008';
const CARD = '00000000-0000-4000-8000-00000000e020';

type Role = 'parent' | 'teen' | 'guest';
const MEMBERS: Record<Role, { memberId: string; userId: string }> = {
  parent: { memberId: PARENT, userId: PARENT_USER },
  teen: { memberId: TEEN, userId: USER },
  guest: { memberId: GUEST, userId: GUEST_USER },
};
const asMember = (role: Role): ServiceScope => ({ db, familyId: FAMILY, ...MEMBERS[role], role, actorKind: 'member', tz: 'UTC', now: new Date(NOW) });
const asAssistantOf = (role: Role): ServiceScope => ({ ...asMember(role), actorKind: 'ai' });
const signedInAs = (role: Role) => {
  actions.as = { user: { id: MEMBERS[role].userId }, active: { familyId: FAMILY, role, family: { name: 'Family', timezone: 'UTC' }, member: { id: MEMBERS[role].memberId } } };
};

/** An insurance card the family holds, as resolveSuggestion's stamps are minted from it. */
function policyCard(memberId: string | null, over: Record<string, unknown> = {}) {
  return { id: CARD, family_id: FAMILY, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: '00000000-0000-4000-8000-00000000e021', member_id: memberId, action_type: 'create_reminder', title: TITLE, detail: DETAIL, urgency: 60, payload: { title: TITLE }, ...over };
}
type Card = ReturnType<typeof policyCard>;
/** The reminder a manager's "Add reminder" wrote for `minted`, while the family now holds `held` (null: no card at all). */
async function acceptedReminder(id: string, minted: Card, held: Card | null, over: Record<string, unknown> = {}): Promise<void> {
  if (held) db.seed('autopilot_suggestions', [held]);
  db.seed('family_reminders', [{ ...personal(id), title: minted.title, member_id: null, idempotency_key: await mintSuggestionReminderKey(FAMILY, minted.id), tags: [await mintSuggestionSourceTag(minted)], ...over }]);
}
const rowOf = (id: string) => db.table('family_reminders').find((row) => row.id === id);
/** Every table the calls touched, but the reminder's and the card's own, as text. */
const elsewhere = () => JSON.stringify([...new Set(db.log.map((entry) => entry.table))]
  .filter((table) => table !== 'family_reminders' && table !== 'autopilot_suggestions')
  .map((table) => [table, db.table(table)]));
const ledgerOf = (outcome: { toolCallId: string | null }) => {
  const row = db.table('ai_tool_calls').find((call) => call.id === outcome.toolCallId);
  expect(row, 'the call left a receipt').toBeDefined();
  return { state: row!.state, error: row!.error, outputs: row!.outputs, tool_name: row!.tool_name };
};
/** Everything written to the console while `run` ran, as text. */
async function consoleDuring<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const spies = (['error', 'warn', 'log', 'info'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  try {
    const result = await run();
    const calls = spies.flatMap((spy) => spy.mock.calls);
    return { result, logged: JSON.stringify(calls, (_key, value: unknown) => (value instanceof Error ? { message: value.message, stack: value.stack } : value)) };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('a hidden id answers exactly as an unknown id, and tells no one its title', () => {
  beforeEach(() => cardReminder(false));

  it.each(['reminders.complete', 'reminders.snooze'])('%s by a hidden id: the reply, receipt and logs of an id the family does not hold', async (name) => {
    const before = snapshot();
    const input = (id: string) => ({ reminder_id: id, ...(name === 'reminders.snooze' ? { minutes: 30 } : {}) });

    const hidden = await consoleDuring(() => executeTool(scope(), name, input('insurance-reminder')));
    const unknown = await consoleDuring(() => executeTool(scope(), name, input(UNKNOWN)));

    expect(snapshot()).toEqual(before);
    expect(hidden.result.status).toBe('error');
    expect({ ...hidden.result, toolCallId: null }).toEqual({ ...unknown.result, toolCallId: null });
    expect(ledgerOf(hidden.result)).toEqual({ ...ledgerOf(unknown.result), tool_name: name });
    expect(ledgerOf(hidden.result)).toMatchObject({ state: 'failed', error: 'That reminder could not be found.' });
    for (const text of [JSON.stringify(hidden.result), elsewhere(), hidden.logged]) {
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain(DETAIL);
    }
  });

  it('the title path does not reach it either', async () => {
    const before = snapshot();
    const outcome = await executeTool(scope(), 'reminders.complete', { title: 'Synthetic private' });
    expect(outcome.status).toBe('error');
    expect(snapshot()).toEqual(before);
    expect(JSON.stringify(outcome)).not.toContain(TITLE);
  });
});

describe('the actors the reader keeps still act by id', () => {
  beforeEach(() => {
    db.seed('family_members', [
      { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true },
      { id: GUEST, family_id: FAMILY, user_id: GUEST_USER, role: 'guest', is_active: true },
    ]);
  });

  it('a parent completes and snoozes the policy reminder the teen is not shown', async () => {
    await cardReminder(false);
    expect(await executeTool(asAssistantOf('parent'), 'reminders.snooze', { reminder_id: 'insurance-reminder', minutes: 30 })).toMatchObject({ status: 'ok', data: { id: 'insurance-reminder', status: 'snoozed' } });
    expect(await completeReminder(asMember('parent'), 'insurance-reminder')).toMatchObject({ ok: true, data: { id: 'insurance-reminder', status: 'completed' } });
  });

  it('an ordinary reminder assigned to someone else is the teen’s to tick off', async () => {
    db.seed('family_reminders', [{ ...personal('assigned'), title: 'Take the bins out', member_id: PARENT, assigned_to_id: PARENT_USER }]);
    expect(await eligible()).toContain('assigned');
    expect(await dispatch('assigned-complete', 'reminders.complete', 'assigned')).toMatchObject({ status: 'ok', data: { id: 'assigned', status: 'completed' } });
  });

  it('a link no card answers is the managers’ alone: the teen is refused, the parent is not', async () => {
    // Accepted from a card since deleted: its key and its tag name no card the family holds.
    await acceptedReminder('orphan', policyCard(TEEN), null);
    const before = snapshot();
    expect(await completeReminder(asAssistantOf('teen'), 'orphan')).toEqual({ ok: false, error: 'That reminder could not be found.', code: 'not_found' });
    expect(snapshot()).toEqual(before);
    expect(await completeReminder(asMember('parent'), 'orphan')).toMatchObject({ ok: true, data: { id: 'orphan', status: 'completed' } });
  });

  it('a not-guests card’s reminder acts for the teen and refuses the guest', async () => {
    const renewal = policyCard(null, { kind: 'document', source_kind: 'renewals', title: 'Renew Passport', payload: { title: 'Renew Passport' } });
    await acceptedReminder('passport', renewal, renewal);
    const before = snapshot();
    expect(await snoozeReminder(asMember('guest'), 'passport', 30)).toEqual({ ok: false, error: 'That reminder could not be found.', code: 'not_found' });
    expect(snapshot()).toEqual(before);
    expect(await snoozeReminder(asMember('teen'), 'passport', 30)).toMatchObject({ ok: true, data: { id: 'passport', status: 'snoozed' } });
  });
});

describe('a failed read of the cards refuses, retryable, and writes nothing', () => {
  const cardsDown = () => {
    holder.db = withFaults(db, (table) => (table === 'autopilot_suggestions' ? { message: 'synthetic outage' } : null));
    return holder.db as DB;
  };

  it.each(['reminders.complete', 'reminders.snooze'])('%s by id, for the teen the card names and for a parent alike', async (name) => {
    db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true }]);
    await cardReminder(true);
    const down = cardsDown();
    const before = snapshot();
    for (const actor of [scope(), asAssistantOf('parent')]) {
      const outcome = await consoleDuring(() => executeTool({ ...actor, db: down }, name, { reminder_id: 'insurance-reminder', ...(name === 'reminders.snooze' ? { minutes: 30 } : {}) }));
      expect(outcome.result).toMatchObject({ status: 'error', error: 'Could not load that reminder.', retryable: true });
      expect(JSON.stringify(outcome.result)).not.toContain(TITLE);
      expect(outcome.logged).not.toContain(TITLE);
    }
    expect(snapshot()).toEqual(before);
  });

  it('a failed read of the reminder itself refuses the snooze and the remove', async () => {
    db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true }]);
    await cardReminder(true);
    // Every read of one reminder fails (withFaults cannot reach `maybeSingle`,
    // which answers without `then`); the writes themselves would not.
    const down = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'from') return Reflect.get(target, property, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table !== 'family_reminders') return builder;
          let writes = false;
          const proxy: object = new Proxy(builder, {
            get(object, key) {
              const value = Reflect.get(object, key);
              if (typeof value !== 'function') return value;
              if (key === 'update' || key === 'delete') writes = true;
              if (key === 'maybeSingle' && !writes) {
                return async () => ({ data: null, error: { code: 'XX000', message: 'synthetic outage', details: null, hint: null }, count: null, status: 400, statusText: 'Bad Request' });
              }
              return (...args: unknown[]) => {
                const result = Reflect.apply(value, object, args);
                return result === object ? proxy : result;
              };
            },
          });
          return proxy;
        };
      },
    }) as DB;
    const before = snapshot();
    const snoozed = await consoleDuring(() => snoozeReminder({ ...asMember('teen'), db: down }, 'insurance-reminder', 30));
    const removed = await consoleDuring(() => deleteReminder({ ...asMember('parent'), db: down }, 'insurance-reminder'));
    for (const outcome of [snoozed, removed]) {
      expect(outcome.result).toMatchObject({ ok: false, code: 'db' });
      expect(JSON.stringify(outcome.result)).not.toContain(TITLE);
      expect(outcome.logged).not.toContain(TITLE);
    }
    expect(snapshot()).toEqual(before);
  });

  it('a reminder with no card to read is untouched by the outage', async () => {
    db.seed('family_reminders', [personal('personal-outage')]);
    const down = cardsDown();
    expect(await completeReminder({ ...asMember('teen'), db: down }, 'personal-outage')).toMatchObject({ ok: true, data: { status: 'completed' } });
  });
});

describe('the reminders page: snooze and remove by id', () => {
  beforeEach(() => {
    db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true }]);
  });

  it('snoozing a hidden id answers what an unknown id answers, and moves nothing', async () => {
    await cardReminder(false);
    signedInAs('teen');
    const before = snapshot();
    const hidden = await snoozeReminderAction('insurance-reminder', 30);
    expect(hidden).toEqual(await snoozeReminderAction(UNKNOWN, 30));
    expect(hidden).toEqual({ ok: false, error: 'That reminder could not be found.' });
    expect(snapshot()).toEqual(before);
    expect(elsewhere()).not.toContain(TITLE);

    signedInAs('parent');
    expect(await snoozeReminderAction('insurance-reminder', 30)).toEqual({ ok: true, id: 'insurance-reminder' });
    expect(rowOf('insurance-reminder')).toMatchObject({ status: 'snoozed' });
  });

  it('the teen who added a policy’s reminder cannot remove it once the policy no longer names them', async () => {
    // Accepted while the card named the teen (resolveSuggestion admits the
    // card's readers), so the teen is its author; the card names the parent now.
    await acceptedReminder('insurance-reminder', policyCard(TEEN), policyCard(PARENT), { created_by: USER });
    signedInAs('teen');
    const before = snapshot();
    const outcome = await consoleDuring(() => deleteReminderAction('insurance-reminder'));
    expect(outcome.result).toEqual({ ok: false, error: 'That reminder could not be found.' });
    expect(snapshot()).toEqual(before);
    expect(elsewhere()).not.toContain(TITLE);
    expect(outcome.logged).not.toContain(TITLE);

    signedInAs('parent');
    expect(await deleteReminderAction('insurance-reminder')).toEqual({ ok: true, id: 'insurance-reminder' });
    expect(rowOf('insurance-reminder')).toBeUndefined();
  });

  it('the teen still snoozes and removes their own', async () => {
    db.seed('family_reminders', [{ ...personal('own'), created_by: USER }]);
    signedInAs('teen');
    expect(await snoozeReminderAction('own', 30)).toEqual({ ok: true, id: 'own' });
    expect(await deleteReminderAction('own')).toEqual({ ok: true, id: 'own' });
    expect(rowOf('own')).toBeUndefined();
  });

  it('the service’s remove answers a hidden id as an unknown one for every caller, the life-events undo included', async () => {
    await cardReminder(false);
    const before = snapshot();
    const hidden = await deleteReminder(asMember('teen'), 'insurance-reminder');
    expect(hidden).toEqual(await deleteReminder(asMember('teen'), UNKNOWN));
    expect(hidden).toEqual({ ok: false, error: 'That reminder could not be found.', code: 'not_found' });
    expect(snapshot()).toEqual(before);
    expect(elsewhere()).not.toContain(TITLE);
  });
});

describe('a run’s verification does not compare a hidden reminder against a guess', () => {
  const POLICY_REMINDER = '00000000-0000-4000-8000-00000000e030';
  const NOWHERE = '00000000-0000-4000-8000-00000000e031';
  const guess = (id: string) => {
    const spec = parseVerificationSpec({ checks: [{ kind: 'fields_match', table: 'family_reminders', id, expect: { title: TITLE } }] });
    if (!spec.ok) throw new Error(spec.error);
    return spec.data;
  };

  it('the teen’s run is told the record does not exist, as for an id the family does not hold', async () => {
    await acceptedReminder(POLICY_REMINDER, policyCard(PARENT), policyCard(PARENT));
    const hidden = await runVerification(asAssistantOf('teen'), guess(POLICY_REMINDER));
    expect(hidden).toEqual(await runVerification(asAssistantOf('teen'), guess(NOWHERE)));
    expect(hidden).toMatchObject({ ok: true, data: { verified: false, checks: [{ verified: false, detail: 'That record no longer exists.' }] } });
  });

  it('the parent’s run still compares it', async () => {
    await acceptedReminder(POLICY_REMINDER, policyCard(PARENT), policyCard(PARENT));
    expect(await runVerification(asAssistantOf('parent'), guess(POLICY_REMINDER))).toMatchObject({ ok: true, data: { verified: true } });
  });
});
