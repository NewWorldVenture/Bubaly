import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextBundle } from '@/lib/ai/context/builder';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ client: null as unknown }));
const provider = vi.hoisted(() => vi.fn(() => { throw new Error('No provider is configured'); }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.client, createServer: async () => holder.client }));
vi.mock('@/lib/ai/routing', () => ({ resolveProviderForTask: provider }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { planRequest } = await import('@/lib/ai/planner');
const { purchaseInputFromRequest } = await import('@/lib/ai/planner/purchase-advice');
const { submitRequest } = await import('@/lib/ai/runs/intake');
const { decide } = await import('@/lib/services/approvals');
const NOW = new Date('2026-09-09T12:00:00Z');
const TEXT = 'Should we buy another cordless drill for $20? Budget category: tools';
const context: ContextBundle = {
  header: { familyName: 'Ours', tz: 'UTC', locale: 'en-US', currency: 'USD', nowIso: NOW.toISOString(), todayKey: '2026-09-09', viewerRole: 'parent', viewerName: 'Parent' },
  slices: {}, stats: {}, sensitiveOmitted: [], text: '',
};
let db: InMemorySupabase;
let scope: ServiceScope;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ userId: 'auth' });
  holder.client = db;
  scope = { db: db as unknown as ServiceScope['db'], familyId: 'ours', userId: 'auth', memberId: 'member', role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW };
  db.seed('families', [{ id: 'ours', name: 'Ours', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'member', family_id: 'ours', user_id: 'auth', display_name: 'Parent', role: 'parent', is_active: true, birthday: null }]);
  db.seed('family_ai_settings', [{ family_id: 'ours', memory_enabled: true }]);
  db.seed('ai_requests', [{ id: 'request', family_id: 'ours', requested_by: 'auth', requested_by_member_id: 'member', request_text: TEXT, status: 'queued' }]);
  db.seed('inventory_items', [
    ...['Garage', 'Workshop', 'Shed', 'Basement'].map((place, index) => ({
      id: `drill-${index}`, family_id: 'ours', name: `${place} cordless drill`, category: 'tools', quantity: 1, brand: 'Bosch', model: '18V', status: 'in_place', tags: [],
    })),
    { id: 'foreign', family_id: 'theirs', name: 'Secret cordless drill', quantity: 1, tags: [] },
  ]);
  db.seed('budgets', [{ id: 'budget', family_id: 'ours', category: 'tools', period: 'monthly', amount: 100 }]);
  db.seed('transactions', [{ id: 'spent', family_id: 'ours', category: 'tools', type: 'expense', amount: 89, date: '2026-09-03' }]);
});
afterEach(() => vi.restoreAllMocks());

const request = (requestText = TEXT) => ({ requestId: 'request', requestText, intent: 'purchase_advice' as const, context, entities: { item: 'another cordless drill' } });
function policy(effect: 'deny' | 'require_approval') {
  db.seed('trust_policies', [{ id: 'policy', family_id: 'ours', domain: 'finances', capability: 'view', subject_kind: 'ai', enabled: true, effect, priority: 1, required_approvals: 1 }]);
}
function expectFullReport(text: string) {
  expect(text).toContain('You already own');
  for (const place of ['Garage', 'Workshop', 'Shed', 'Basement']) expect(text).toContain(`${place} cordless drill`);
  expect(text).toContain('$89.00');
  expect(text).toContain('$100.00');
  expect(text).toContain('-$9.00');
  expect(text).not.toContain('Secret cordless drill');
}

describe('purchase questions through the actual planner and intake', () => {
  it('reads household evidence and returns the complete answer without calling a provider or making a run', async () => {
    const result = await planRequest(scope, request(), { db: scope.db, now: NOW });
    expect(result).toMatchObject({ ok: true, data: { kind: 'answer' } });
    if (!result.ok || result.data.kind !== 'answer') throw new Error('Expected an answer');
    expectFullReport(result.data.text);
    expect(provider).not.toHaveBeenCalled();
    expect(db.table('ai_requests')[0]).toMatchObject({ status: 'completed', error: null });
    expect(db.table('ai_plans')).toHaveLength(0);
    expect(db.table('ai_run_events')).toHaveLength(0);
    expect(db.table('ai_tool_calls')).toHaveLength(0);
    expect(db.table('trust_audit_logs')).toEqual(expect.arrayContaining([expect.objectContaining({ actor_kind: 'ai_agent', domain: 'finances', capability: 'view' })]));
  });

  it('carries the whole answer through submitRequest and its owned conversation with no configured provider', async () => {
    db.seed('ai_conversations', [{ id: 'conversation', family_id: 'ours', user_id: 'auth' }]);
    const kick = vi.fn();
    const result = await submitRequest(scope, { text: TEXT, conversationId: 'conversation' }, { db: scope.db, now: NOW, kick });
    expect(result).toMatchObject({ ok: true, data: { outcome: 'answer', runId: null, planId: null } });
    if (!result.ok) throw new Error(result.error);
    expectFullReport(result.data.summary);
    expect(db.table('ai_messages').find((row) => row.role === 'assistant')).toMatchObject({ conversation_id: 'conversation', content: result.data.summary });
    expect(provider).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it('honours an AI-specific deny before reading evidence or answering', async () => {
    policy('deny');
    const result = await planRequest(scope, request(), { db: scope.db });
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(db.log.some((entry) => entry.table === 'inventory_items')).toBe(false);
    expect(db.table('ai_requests')[0].status).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not preload sensitive purchase context before the intake trust decision', async () => {
    policy('deny');
    const result = await submitRequest(scope, { text: TEXT }, { db: scope.db, now: NOW, kick: vi.fn() });
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    const visited = db.log.map((entry) => entry.table);
    for (const table of ['inventory_items', 'budgets', 'transactions', 'family_facts']) expect(visited).not.toContain(table);
    expect(provider).not.toHaveBeenCalled();
  });

  it('returns a navigable private destination through ordinary Ask while approval is pending', async () => {
    policy('require_approval');
    const result = await submitRequest(scope, { text: TEXT }, { db: scope.db, now: NOW, kick: vi.fn() });
    const approval = db.table('approval_requests')[0];
    expect(result).toMatchObject({ ok: true, data: { outcome: 'answer', redirect: `/dashboard/assistant/purchases/${approval.id}` } });
    if (!result.ok) throw new Error(result.error);
    expect(approval.request_id).toBe(result.data.requestId);
    expect(result.data.summary).not.toMatch(/cordless drill|\$89|\$100|\$9/i);
    expect(db.log.some((entry) => entry.table === 'inventory_items')).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it('files an executable approval, shows a private waiting link, and privately retains the report after approval', async () => {
    policy('require_approval');
    db.seed('wishlist_items', [{ id: 'own-gift', family_id: 'ours', member_id: 'member', title: 'Cordless drill', price: 40, is_purchased: true }]);
    const waiting = await planRequest(scope, request(), { db: scope.db });
    expect(waiting).toMatchObject({ ok: true, data: { kind: 'answer' } });
    expect(db.log.some((entry) => entry.table === 'inventory_items')).toBe(false);
    const approval = db.table('approval_requests')[0];
    expect(approval).toMatchObject({ request_id: 'request', requested_by_kind: 'ai', requested_by_member_id: 'member', status: 'pending', payload: { name: 'finances.advisePurchase', args: { priceDollars: 20, budgetCategory: 'tools' } } });
    expect(waiting).toMatchObject({ ok: true, data: { href: `/dashboard/assistant/purchases/${approval.id}`, card: { href: `/dashboard/assistant/purchases/${approval.id}` } } });
    const approved = await decide(scope, String(approval.id), 'approved');
    expect(approved).toMatchObject({ ok: true, data: { executed: true, status: 'approved' } });
    if (!approved.ok) throw new Error(approved.error);
    const privateMessage = db.table('ai_messages').find((row) => row.role === 'assistant' && String(row.content).includes('Garage cordless drill'));
    expect(privateMessage).toBeDefined();
    expectFullReport(String(privateMessage!.content));
    expect(String(privateMessage!.content).toLowerCase()).not.toContain('already bought');
    expect(db.table('ai_conversations').find((row) => row.id === privateMessage!.conversation_id)).toMatchObject({ user_id: 'auth', family_id: 'ours' });
    expect(approved.data.summary).not.toMatch(/cordless drill|\$89|\$100|\$9/i);
    expect(db.table('approval_requests')[0].execution_result).toBe(approved.data.summary);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not return a verdict after a household read fails', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'inventory_items') throw new Error('offline');
      return from(table);
    });
    expect(await planRequest(scope, request(), { db: scope.db })).toMatchObject({ ok: false, retryable: true });
    expect(db.table('ai_requests')[0].status).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('explicit purchase details', () => {
  it.each([
    ['a 20V drill', null], ['a drill for $20.50', 20.5], ['a drill for USD 1,200', 1200], ['a drill for 19 dollars', 19],
    ['a drill for $20 or $30', null], ['a drill for $-20', null], ['a drill for -$20', null], ['a drill for $12,34', null], ['a drill for $20.555', null], ['a drill for $20abc', null], ['a drill for $20.12.34', null], ['a drill for $20.', 20],
  ])('only uses one explicit valid price in %s', (text, expected) => {
    expect(purchaseInputFromRequest({ requestId: 'request', requestText: text, entities: { price: '42' } }).priceDollars).toBe(expected);
  });
  it('only forwards a category explicitly labelled by the person', () => {
    expect(purchaseInputFromRequest({ requestId: 'request', requestText: 'a drill', entities: { budgetCategory: 'tools' } }).budgetCategory).toBeNull();
    expect(purchaseInputFromRequest({ requestId: 'request', requestText: 'a drill from the "Tools" budget' }).budgetCategory).toBe('Tools');
  });
  it('keeps product sizes while separating explicit price and budget clauses from the item', () => {
    const text = 'Should we buy a Bosch 20V cordless drill for $50? Budget category: tools';
    expect(purchaseInputFromRequest({ requestId: 'request', requestText: text, entities: { item: 'a Bosch 20V cordless drill for $50? Budget category: tools' } }))
      .toEqual({ text: 'a Bosch 20V cordless drill', priceDollars: 50, budgetCategory: 'tools' });
  });
});
