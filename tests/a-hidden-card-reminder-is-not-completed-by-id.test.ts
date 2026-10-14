// Bounded source/tool contract diagnostic. The table model has no RLS or real Auth.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));

import { completeReminder, snoozeReminder } from '@/lib/services/reminders';
import { executeTool } from '@/lib/ai/tools/execute';
import { getTool } from '@/lib/ai/tools/registry';
import { evaluateTrust } from '@/lib/trust/server';
import { riskToDecision } from '@/lib/trust/engine';
import { readVisibleReminders, reminderCardsReader } from '@/lib/autopilot/reminder-cards';
import { mintSuggestionReminderKey, mintSuggestionSourceTag } from '@/lib/autopilot/reminder-key';

const FAMILY = '00000000-0000-4000-8000-00000000e001';
const OTHER = '00000000-0000-4000-8000-00000000e002';
const TEEN = '00000000-0000-4000-8000-00000000e003';
const USER = '00000000-0000-4000-8000-00000000e004';
const PARENT = '00000000-0000-4000-8000-00000000e005';
const NOW = '2026-10-12T12:00:00.000Z';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const scope = (): ServiceScope => ({ db, familyId: FAMILY, userId: USER, memberId: TEEN, role: 'teen', actorKind: 'ai', tz: 'UTC', now: new Date(NOW) });
const snapshot = () => JSON.parse(JSON.stringify(db.table('family_reminders'))) as Record<string, unknown>[];
function persist(label: string, value: unknown): void {
  const dir = process.env.REMINDER_SIX_TELEMETRY_DIR;
  if (!dir) return;
  writeFileSync(`${dir}/${label}.json`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function personal(id: string, familyId = FAMILY): Record<string, unknown> {
  return { id, family_id: familyId, title: 'Synthetic personal reminder', remind_at: '2026-10-13T12:00:00.000Z', recurrence: 'none', status: 'active', priority: 'medium', member_id: TEEN, tags: [], related_type: null, related_id: null, idempotency_key: null, autopilot_origin: false, autopilot_card_id: null };
}
async function cardReminder(named: boolean): Promise<void> {
  const card = { id: '00000000-0000-4000-8000-00000000e010', family_id: FAMILY, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: '00000000-0000-4000-8000-00000000e011', member_id: named ? TEEN : PARENT, action_type: 'create_reminder', title: 'Synthetic private policy reminder', detail: 'Synthetic private policy detail', urgency: 60, payload: { title: 'Synthetic private policy reminder' } };
  const idempotency_key = await mintSuggestionReminderKey(FAMILY, card.id);
  const stamp = await mintSuggestionSourceTag(card);
  expect(idempotency_key).toMatch(/^[a-f0-9]{64}$/);
  expect(stamp).toMatch(/^autopilot-source:[a-f0-9]{64}$/);
  db.seed('autopilot_suggestions', [card]);
  db.seed('family_reminders', [{ ...personal('insurance-reminder'), title: card.title, member_id: null, idempotency_key, tags: [stamp], autopilot_origin: true, autopilot_card_id: card.id }]);
}
async function eligible(): Promise<string[]> {
  const result = await readVisibleReminders<Record<string, unknown> & { id: string; related_type: string | null; related_id: string | null; tags: string[]; idempotency_key: string | null }>(
    async (from, to) => {
      const reply = await db.from('family_reminders').select('*').eq('family_id', FAMILY).order('remind_at').order('id').range(from, to);
      return { data: reply.data as (Record<string, unknown> & { id: string; related_type: string | null; related_id: string | null; tags: string[]; idempotency_key: string | null })[] | null, error: reply.error };
    },
    { limit: 20, viewer: { role: 'teen', memberId: TEEN }, cards: reminderCardsReader(db, FAMILY, { onError: error => { throw error; }, keyOf: id => mintSuggestionReminderKey(FAMILY, id), sourceTagOf: mintSuggestionSourceTag }) },
  );
  expect(result.error).toBeNull();
  return (result.data ?? []).map(row => String(row.id));
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
  const authority = await admission();
  const visibleIds = await eligible();
  const before = snapshot();
  const previousReceiptIds = new Set(db.table('ai_tool_calls').map(row => row.id));
  const outcome = await executeTool(scope(), name, { reminder_id: id, ...(name === 'reminders.snooze' ? { minutes: 30 } : {}) });
  // Persist actual observations BEFORE any desired privacy assertion.
  persist(label, { model: 'source/tool contract only; no RLS', authority, visibleIds, before, after: snapshot(), outcome, trustAudit: db.table('trust_audit_logs'), approvals: db.table('approval_requests'), ledger: db.table('ai_tool_calls') });
  expect(db.table('approval_requests')).toHaveLength(0);
  expect(db.table('trust_audit_logs').some(row => row.decision === 'allow' && (row.context as { basis?: string } | null)?.basis === 'risk_tier')).toBe(true);
  const newReceipts = db.table('ai_tool_calls').filter(row => !previousReceiptIds.has(row.id));
  expect(newReceipts).toHaveLength(1);
  expect(newReceipts[0]).toMatchObject({ id: outcome.toolCallId, family_id: FAMILY, tool_name: name, requested_by: USER, requested_by_member_id: TEEN });
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

// Direct service controls use the same real visibility/mints and forwarding DB model.
describe('service mutation admission preserves authorized paths and fails closed', () => {
  const asManager = (): ServiceScope => {
    const parentUser = '00000000-0000-4000-8000-00000000e006';
    db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: parentUser, role: 'parent', is_active: true }]);
    return { ...scope(), role: 'parent', memberId: PARENT, userId: parentUser };
  };
  async function refusePair(label: string, caller: ServiceScope): Promise<void> {
    const before = snapshot();
    const completed = await completeReminder(caller, 'insurance-reminder');
    persist(label + '-complete', { before, after: snapshot(), result: completed });
    expect(snapshot()).toEqual(before);
    expect(completed.ok).toBe(false);
    expect(JSON.stringify(completed)).not.toContain('Synthetic private policy reminder');
    const snoozed = await snoozeReminder(caller, 'insurance-reminder', 30);
    persist(label + '-snooze', { before, after: snapshot(), result: snoozed });
    expect(snapshot()).toEqual(before);
    expect(snoozed.ok).toBe(false);
    expect(JSON.stringify(snoozed)).not.toContain('Synthetic private policy reminder');
  }
  it('protects direct service callers from the hidden insurance reminder', async () => {
    await cardReminder(false);
    expect(await eligible()).not.toContain('insurance-reminder');
    await refusePair('direct-hidden', scope());
  });
  it('preserves a current manager completing and snoozing a private reminder', async () => {
    await cardReminder(false);
    const caller = asManager();
    const complete = await completeReminder(caller, 'insurance-reminder');
    persist('manager-complete', { result: complete, rows: snapshot() });
    expect(complete).toMatchObject({ ok: true, data: { id: 'insurance-reminder', status: 'completed' } });
    const snooze = await snoozeReminder(caller, 'insurance-reminder', 30);
    persist('manager-snooze', { result: snooze, rows: snapshot() });
    expect(snooze).toMatchObject({ ok: true, data: { id: 'insurance-reminder', status: 'snoozed' } });
  });
  it('keeps unlinked personal mutations independent of a failed card lookup', async () => {
    db.seed('family_reminders', [personal('insurance-reminder')]);
    let cardReads = 0;
    const faulted = withFaults(db, table => { if (table !== 'autopilot_suggestions') return null; cardReads++; return { message: 'Synthetic card read failure' }; });
    const caller = { ...scope(), db: faulted };
    const complete = await completeReminder(caller, 'insurance-reminder');
    const snooze = await snoozeReminder(caller, 'insurance-reminder', 30);
    persist('unlinked-card-independent', { complete, snooze, cardReads, rows: snapshot() });
    expect(complete.ok).toBe(true);
    expect(snooze.ok).toBe(true);
    expect(cardReads).toBe(0);
  });
  it('refuses an unresolved stamped reminder to a nonmanager', async () => {
    await cardReminder(false);
    db.table('autopilot_suggestions').splice(0);
    expect(await eligible()).not.toContain('insurance-reminder');
    await refusePair('orphan', scope());
  });
  it('refuses a normally named reader when the card read resolves an error', async () => {
    await cardReminder(true);
    expect(await eligible()).toContain('insurance-reminder');
    let failures = 0;
    const faulted = withFaults(db, table => { if (table !== 'autopilot_suggestions') return null; failures++; return { message: 'Synthetic card read failure' }; });
    await refusePair('named-card-read-error', { ...scope(), db: faulted });
    expect(failures).toBe(2);
  });
  it('refuses even a manager when the card read resolves an error', async () => {
    await cardReminder(false);
    const manager = asManager();
    let failures = 0;
    const faulted = withFaults(db, table => { if (table !== 'autopilot_suggestions') return null; failures++; return { message: 'Synthetic card read failure' }; });
    await refusePair('manager-card-read-error', { ...manager, db: faulted });
    expect(failures).toBe(2);
  });
  it('refuses both operations when the initial reminder read resolves an error', async () => {
    await cardReminder(true);
    const calls: string[] = [];
    const faulted = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'from') return Reflect.get(target, property, receiver);
        return (table: string) => {
          const builder = target.from(table);
          let isUpdate = false;
          const query = new Proxy(builder, {
            get(original, method) {
              const value = Reflect.get(original, method);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                if (table === 'family_reminders') calls.push(String(method));
                if (method === 'update') isUpdate = true;
                if (table === 'family_reminders' && method === 'maybeSingle' && !isUpdate) {
                  return Promise.resolve({ data: null, error: { code: 'XX000', message: 'Synthetic reminder read failure', details: null, hint: null }, count: null, status: 400, statusText: 'Bad Request' });
                }
                const result = Reflect.apply(value, original, args);
                return result === original ? query : result;
              };
            },
          });
          return query;
        };
      },
    });
    const prerequisite = await faulted.from('family_reminders').select('*').eq('id', 'insurance-reminder').eq('family_id', FAMILY).maybeSingle();
    expect(prerequisite.error?.message).toBe('Synthetic reminder read failure');
    expect(prerequisite.data).toBeNull();
    calls.length = 0;
    await refusePair('initial-reminder-read-error', { ...scope(), db: faulted });
    expect(calls).toContain('select');
    expect(calls).not.toContain('update');
  });
});
