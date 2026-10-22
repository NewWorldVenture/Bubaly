// "Bubaly may spend up to $50" is an allow with `conditions.maxAmountCents`,
// and the engine reads the amount off the action's context — a missing one as
// 0 (`conditionsSatisfied`). The planner's dry run and the rule a held step is
// filed under both read the step's amount, but the two gates every other AI
// write goes through did not: `executeTool`'s gate (chat registry tools, a
// planner step the plan did not hold) and `gateAiAction` (chat's legacy tools,
// Magic Import, the school desk). So the $50 allow matched every amount, named
// its domain, silenced the risk tier, and a $900 `finances.updateBudget` ran
// with nobody asked.
//
// Both gates now read the amount from the call's own arguments with the same
// reader (lib/trust/amount.ts). Driven through the real gates, engine,
// registry and finance service on the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { executeTool } = await import('@/lib/ai/tools/execute');
const { gateAiAction } = await import('@/lib/trust/ai-gate');
const { readAmountCents } = await import('@/lib/trust/amount');

const FAMILY = '00000000-0000-4000-8000-00000000ab01';
const MUM = { member: '00000000-0000-4000-8000-00000000ab11', user: '00000000-0000-4000-8000-00000000ab21' };
const NOW = new Date('2026-09-05T12:00:00Z');

/** What the Trust form saves for "Bubaly may spend up to $50". */
const UP_TO_FIFTY = {
  id: '00000000-0000-4000-8000-00000000ab31', family_id: FAMILY, name: 'Bubaly may spend up to $50', domain: 'finances',
  capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null, effect: 'allow',
  conditions: { maxAmountCents: 5000 }, approval_model: 'single', required_approvals: 1, priority: 300, enabled: true,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

const parentsAssistant = (): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: MUM.user, memberId: MUM.member, role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] },
    },
  });
  holder.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: MUM.member, family_id: FAMILY, user_id: MUM.user, role: 'parent', is_active: true, display_name: 'Mum' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('trust_policies', [UP_TO_FIFTY]);
  db.seed('budgets', [{ id: 'budget-groceries', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const groceries = () => db.table('budgets').find((b) => b.id === 'budget-groceries');

describe('executeTool reads the amount a capped allow is written against', () => {
  it('holds a $900 budget for a person — the $50 allow does not reach it', async () => {
    const outcome = await executeTool(parentsAssistant(), 'finances.updateBudget', { category: 'Groceries', amount: 900 });

    expect(outcome.status).toBe('pending_approval');
    expect(groceries()).toMatchObject({ amount: 400 });
    const [approval] = db.table('approval_requests');
    expect(approval).toMatchObject({
      status: 'pending', domain: 'finances', amount_cents: 90_000, requested_by_member_id: MUM.member,
      payload: { name: 'finances.updateBudget', args: { category: 'Groceries', amount: 900 } },
    });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('still lets the $50 allow run a $20 budget unasked', async () => {
    const outcome = await executeTool(parentsAssistant(), 'finances.updateBudget', { category: 'Groceries', amount: 20 });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(groceries()).toMatchObject({ amount: 20 });
    expect(db.table('approval_requests')).toEqual([]);
  });
});

describe('gateAiAction reads it from the `{ name, args }` every caller files', () => {
  const ask = (amount: number) => gateAiAction(client(), FAMILY, {
    toolName: 'update_budget', domain: 'finances', actorId: 'assistant', actorRole: 'parent', agent: 'AI Assistant',
    onBehalfOfMemberId: MUM.member, title: `Set the Groceries budget to $${amount}`,
    payload: { name: 'update_budget', args: { category: 'Groceries', amount } },
  });

  it('asks a person before a $900 budget', async () => {
    const outcome = await ask(900);

    expect(outcome.effect).toBe('require_approval');
    const [approval] = db.table('approval_requests');
    expect(outcome).toMatchObject({ approvalId: approval.id });
    expect(approval).toMatchObject({ status: 'pending', amount_cents: 90_000, payload: { name: 'update_budget', args: { amount: 900 } } });
  });

  it('still allows a $20 budget under the $50 rule', async () => {
    expect(await ask(20)).toEqual({ effect: 'allow' });
    expect(db.table('approval_requests')).toEqual([]);
  });
});

describe('one reader for every gate', () => {
  it('reads cents as cents and the registry’s dollar fields as dollars', () => {
    expect(readAmountCents({ amount_cents: 1234 })).toBe(1234);
    expect(readAmountCents({ amountCents: 99.6 })).toBe(100);
    expect(readAmountCents({ amount: 900 })).toBe(90_000);
    expect(readAmountCents({ budget: 1500.5 })).toBe(150_050);
    expect(readAmountCents({ target_amount: 12 })).toBe(1200);
    expect(readAmountCents({ cost: 0.5 })).toBe(50);
    expect(readAmountCents({ amount: '900' })).toBeNull();
    expect(readAmountCents({ title: 'Soccer' })).toBeNull();
    expect(readAmountCents(null)).toBeNull();
  });
});
