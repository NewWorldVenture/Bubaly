import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.client }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { scopeForApprovedPurchase, savePrivatePurchaseAnswer, loadPrivatePurchaseAnswer, retryPrivatePurchaseAnswer } = await import('@/lib/services/purchases/private-result');
const { executeTool } = await import('@/lib/ai/tools/execute');
type Approval = Database['public']['Tables']['approval_requests']['Row'];
let db: InMemorySupabase;
let scope: ServiceScope;
const approval = () => db.table('approval_requests')[0] as unknown as Approval;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { ai_conversations: [['id']], ai_messages: [['id']] } });
  holder.client = db;
  scope = { db: db as unknown as ServiceScope['db'], familyId: 'ours', userId: 'requester-user', memberId: 'requester-member',
    role: 'parent', actorKind: 'member', requestId: 'request', tz: 'UTC', now: new Date('2026-09-09T12:00:00Z') };
  db.seed('family_members', [{ id: 'requester-member', family_id: 'ours', user_id: 'requester-user', role: 'parent', is_active: true }]);
  db.seed('ai_requests', [{ id: 'request', family_id: 'ours', requested_by: 'requester-user', requested_by_member_id: 'requester-member', conversation_id: null }]);
  db.seed('approval_requests', [{ id: 'approval', family_id: 'ours', requested_by_kind: 'ai', requested_by_member_id: 'requester-member',
    request_id: 'request', status: 'approved', payload_kind: 'tool', payload: { name: 'finances.advisePurchase', args: { text: 'drill', priceDollars: 20, budgetCategory: 'tools' } } }]);
  db.seed('family_ai_settings', [{ family_id: 'ours', memory_enabled: true }]);
  db.seed('inventory_items', [{ id: 'drill', family_id: 'ours', name: 'Cordless drill', quantity: 1, category: 'tools', tags: [] }]);
  db.seed('budgets', [{ id: 'budget', family_id: 'ours', category: 'tools', period: 'monthly', amount: 100 }]);
  db.seed('transactions', [{ id: 'spent', family_id: 'ours', category: 'tools', type: 'expense', amount: 89, date: '2026-09-03' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('private approved purchase results', () => {
  it('restores the current requester role rather than the approving adult role', async () => {
    db.table('family_members')[0].role = 'child';
    const result = await scopeForApprovedPurchase({ ...scope, userId: 'parent-user', memberId: 'parent-member' }, approval());
    expect(result).toMatchObject({ ok: true, data: { role: 'child', userId: 'requester-user', memberId: 'requester-member', actorKind: 'ai' } });
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true });
    expect(db.log.some((query) => ['budgets', 'transactions'].includes(query.table))).toBe(false);
    expect(db.table('ai_messages')[0].content).not.toContain('$89.00');
  });

  it.each(['inactive', 'removed', 'missing-user', 'changed-user', 'missing-request', 'foreign-request', 'missing-member', 'foreign-approval'])('fails closed for %s ownership', async (condition) => {
    if (condition === 'inactive') db.table('family_members')[0].is_active = false;
    if (condition === 'removed') db.replace('family_members', []);
    if (condition === 'missing-user') db.table('family_members')[0].user_id = null;
    if (condition === 'changed-user') db.table('family_members')[0].user_id = 'someone-else';
    if (condition === 'missing-request') db.replace('ai_requests', []);
    if (condition === 'foreign-request') db.table('ai_requests')[0].family_id = 'theirs';
    if (condition === 'missing-member') db.table('approval_requests')[0].requested_by_member_id = null;
    if (condition === 'foreign-approval') db.table('approval_requests')[0].family_id = 'theirs';
    expect(await scopeForApprovedPurchase(scope, approval())).toMatchObject({ ok: false, code: 'denied' });
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: false, code: 'denied' });
    expect(db.log.some((query) => ['inventory_items', 'budgets', 'family_facts'].includes(query.table))).toBe(false);
    expect(db.table('ai_messages')).toHaveLength(0);
  });

  it('delivers once to an owned conversation for ordinary Ask and never changes the report on redelivery', async () => {
    expect(await savePrivatePurchaseAnswer(scope, 'approval', 'Private original budget')).toMatchObject({ ok: true });
    expect(await savePrivatePurchaseAnswer(scope, 'approval', 'A different answer')).toMatchObject({ ok: true });
    expect(db.table('ai_conversations')).toEqual([expect.objectContaining({ id: 'approval', user_id: 'requester-user', family_id: 'ours' })]);
    expect(db.table('ai_messages')).toEqual([expect.objectContaining({ id: 'approval', content: 'Private original budget', request_id: 'request',
      conversation_id: 'approval', structured_content: { kind: 'purchase_advice_result', approvalId: 'approval' } })]);
    expect(await loadPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true, data: { kind: 'ready', answer: 'Private original budget' } });
    expect(JSON.stringify(db.table('approval_requests'))).not.toContain('Private original budget');
    expect(JSON.stringify(db.table('ai_requests'))).not.toContain('Private original budget');
  });

  it('uses an existing owned conversation when the request has one', async () => {
    db.table('ai_requests')[0].conversation_id = 'conversation';
    db.seed('ai_conversations', [{ id: 'conversation', family_id: 'ours', user_id: 'requester-user' }]);
    expect(await savePrivatePurchaseAnswer(scope, 'approval', 'Private report')).toMatchObject({ ok: true });
    expect(db.table('ai_conversations')).toHaveLength(1);
    expect(db.table('ai_messages')[0].conversation_id).toBe('conversation');
  });

  it.each(['member', 'family'])('hides the private result from another %s even with an unrestricted server client', async (other) => {
    await savePrivatePurchaseAnswer(scope, 'approval', 'Private report');
    const foreign = other === 'member' ? { ...scope, memberId: 'parent-member', userId: 'parent-user' } : { ...scope, familyId: 'theirs' };
    expect(await loadPrivatePurchaseAnswer(foreign, 'approval')).toMatchObject({ ok: false, code: 'denied' });
    expect(await retryPrivatePurchaseAnswer(foreign, 'approval')).toMatchObject({ ok: false, code: 'denied' });
  });

  it.each(['conversation', 'message'])('cannot overwrite a conflicting private %s id', async (collision) => {
    if (collision === 'conversation') db.seed('ai_conversations', [{ id: 'approval', family_id: 'ours', user_id: 'different-owner' }]);
    else db.seed('ai_messages', [{ id: 'approval', family_id: 'theirs', conversation_id: 'foreign', request_id: 'other', content: 'Keep this private' }]);
    expect(await savePrivatePurchaseAnswer(scope, 'approval', 'Wrongly delivered')).toMatchObject({ ok: false, code: 'denied' });
    if (collision === 'conversation') expect(db.table('ai_conversations')[0].user_id).toBe('different-owner');
    else expect(db.table('ai_messages')[0].content).toBe('Keep this private');
  });

  it('exposes a retry after failed private delivery, then stores the report without putting evidence in the receipt', async () => {
    const from = db.from.bind(db);
    const broken = vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'ai_messages') throw new Error('Private storage unavailable');
      return from(table);
    });
    expect(await savePrivatePurchaseAnswer(scope, 'approval', 'Private report')).toMatchObject({ ok: false, retryable: true });
    broken.mockRestore();
    expect(await loadPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true, data: { kind: 'retry' } });
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true });
    const loaded = await loadPrivatePurchaseAnswer(scope, 'approval');
    expect(loaded).toMatchObject({ ok: true, data: { kind: 'ready', answer: expect.stringContaining('$89.00') } });
    expect(approval().execution_result).toContain('Purchase check complete');
    expect(approval().execution_result).not.toContain('$89.00');
    const before = db.log.length;
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true });
    expect(db.table('ai_messages')).toHaveLength(1);
    expect(db.log.slice(before).some((query) => query.table === 'inventory_items')).toBe(false);
  });

  it.each(['pending', 'rejected', 'cancelled'])('never runs a %s approval through retry', async (status) => {
    db.table('approval_requests')[0].status = status;
    expect(await loadPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true, data: { kind: status === 'pending' ? 'waiting' : 'declined' } });
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: false, code: 'denied' });
    expect(db.log.some((query) => query.table === 'inventory_items')).toBe(false);
  });

  it('retries the edited item and price that were approved and ignores extra fields', async () => {
    db.table('approval_requests')[0].status = 'modified';
    db.table('approval_requests')[0].edited_payload = { text: 'hammer', priceDollars: 5, excludeWishId: 'not-offered-on-card' };
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: true });
    const answer = String(db.table('ai_messages')[0].content);
    expect(answer).toContain('hammer');
    expect(answer).toContain('$6.00');
    expect(answer).not.toContain('-$9.00');
  });

  it('fails closed if persisted approved edits do not fit the tool schema', async () => {
    db.table('approval_requests')[0].edited_payload = { priceDollars: -500 };
    expect(await retryPrivatePurchaseAnswer(scope, 'approval')).toMatchObject({ ok: false, code: 'denied' });
    expect(db.table('ai_messages')).toHaveLength(0);
    expect(db.log.some((query) => query.table === 'inventory_items')).toBe(false);
  });
});

describe('purchase approval request association', () => {
  it('keeps the first owned request when repeated questions reuse a pending engine approval', async () => {
    db.replace('approval_requests', []);
    db.seed('trust_policies', [{ id: 'policy', family_id: 'ours', domain: 'finances', capability: 'view', subject_kind: 'ai', enabled: true, effect: 'require_approval', priority: 1, required_approvals: 1 }]);
    const callScope = { ...scope, actorKind: 'ai' as const };
    const args = { text: 'drill' };
    const first = await executeTool(callScope, 'finances.advisePurchase', args);
    expect(first).toMatchObject({ status: 'pending_approval' });
    const firstId = db.table('approval_requests')[0].id;
    db.seed('ai_requests', [{ id: 'second', family_id: 'ours', requested_by: 'requester-user', requested_by_member_id: 'requester-member' }]);
    const second = await executeTool({ ...callScope, requestId: 'second' }, 'finances.advisePurchase', args);
    expect(second).toMatchObject({ status: 'pending_approval', approvalId: firstId });
    expect(db.table('approval_requests')).toHaveLength(1);
    expect(db.table('approval_requests')[0].request_id).toBe('request');
    expect(db.log.some((query) => query.table === 'inventory_items')).toBe(false);
  });

  it('does not offer private delivery without an owned original request', async () => {
    db.replace('approval_requests', []);
    db.seed('trust_policies', [{ id: 'policy', family_id: 'ours', domain: 'finances', capability: 'view', subject_kind: 'ai', enabled: true, effect: 'require_approval', priority: 1, required_approvals: 1 }]);
    db.table('ai_requests')[0].requested_by = 'different-user';
    expect(await executeTool({ ...scope, actorKind: 'ai' }, 'finances.advisePurchase', { text: 'drill' })).toMatchObject({ status: 'denied' });
    expect(db.log.some((query) => query.table === 'inventory_items')).toBe(false);
  });
});
