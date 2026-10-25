// A new purchase is not filed under a removed member (N10-S1).
//
// The N10 fix routed every AI write that takes a member through
// resolveAssigneeId's requireActive. finances.createTransaction did not use the
// resolver: it handed input.member_id straight to createTransaction, whose
// check selected family_members by id and family only. So a removed member's
// id — which family.listMembers { include_inactive } still hands the model —
// became the member_id of a NEW transactions row.
//
// The choice, recorded in createTransaction: a removed member is not the
// spender on a new purchase (record a former member's past purchase with no
// member). The check sits in the service, after the operation-receipt probe,
// so it holds for the AI tool and the money screens alike, and a replay of a
// purchase recorded while they were still a member still returns its receipt.
//
// Driven through the real tool and service against the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn(async () => undefined) }));

const { financeTools } = await import('@/lib/ai/tools/finances');
const { createTransaction } = await import('@/lib/services/finances');

const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const PARENT = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const AVA = 'cccccccc-cccc-4ccc-8ccc-000000000002';
const EX = 'cccccccc-cccc-4ccc-8ccc-000000000003';

type ToolResult = { ok: boolean; code?: string; error?: string; data?: Record<string, unknown> };
const record = financeTools.find((t) => t.name === 'finances.createTransaction') as unknown as {
  execute: (scope: ServiceScope, input: unknown) => Promise<ToolResult>;
  input: { parse: (v: unknown) => unknown };
};

let db: InMemorySupabase;
let scope: ServiceScope;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, display_name: 'Jordan', role: 'parent', is_active: true },
    { id: AVA, family_id: FAMILY, display_name: 'Ava', role: 'teen', is_active: true },
    // Removed last month: REMOVED_MEMBER_PATCH leaves the row, inactive.
    { id: EX, family_id: FAMILY, display_name: 'Ex', role: 'guest', is_active: false },
  ]);
  scope = {
    db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: 'auth-parent', memberId: PARENT,
    role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-10T12:00:00Z'),
  };
});

const purchase = (memberId: string) => record.input.parse({ name: 'Trainers', amount: 64.5, merchant: 'Shoe Shop', member_id: memberId });

describe('finances.createTransaction with a member id', () => {
  it('refuses a removed member\'s id and records nothing', async () => {
    const res = await record.execute(scope, purchase(EX));
    expect(res).toMatchObject({ ok: false, code: 'not_found', error: 'That member is no longer in this family.' });
    expect(db.table('transactions')).toHaveLength(0);
  });

  it('still records a purchase for a current member (control)', async () => {
    const res = await record.execute(scope, purchase(AVA));
    expect(res.ok).toBe(true);
    expect(db.table('transactions')).toEqual([expect.objectContaining({ family_id: FAMILY, member_id: AVA, amount: 64.5 })]);
  });

  it('still refuses another household\'s member as not belonging to this family', async () => {
    db.seed('family_members', [{ id: 'other-member', family_id: 'another-family', display_name: 'Pat', role: 'parent', is_active: true }]);
    const res = await record.execute(scope, purchase('other-member'));
    expect(res).toMatchObject({ ok: false, error: 'That member does not belong to this family.' });
    expect(db.table('transactions')).toHaveLength(0);
  });
});

describe('the money screens\' path (createTransaction with memberId)', () => {
  it('refuses a removed member there as well', async () => {
    const res = await createTransaction({ ...scope, actorKind: 'member' }, { name: 'Trainers', amount: 64.5, memberId: EX });
    expect(res).toMatchObject({ ok: false, error: 'That member is no longer in this family.' });
    expect(db.table('transactions')).toHaveLength(0);
  });
});

describe('a replay of a purchase recorded while they were still a member', () => {
  it('returns its receipt rather than refusing the since-removed member', async () => {
    const inputs = { name: 'Trainers', amount: 64.5, merchant: 'Shoe Shop', member_id: EX };
    const original = {
      id: 'txn-1', family_id: FAMILY, name: 'Trainers', amount: 64.5, merchant: 'Shoe Shop', type: 'expense', category: null,
      date: '2026-10-01', notes: null, account_id: null, member_id: EX, receipt_document_id: null,
      source: 'ai', created_by: 'auth-parent', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
    };
    const operations = createInMemorySupabase({
      rpc: {
        finance_record_transaction_operation: (args) => {
          if (args.p_transaction !== null) throw new Error('a replay must not write');
          return { transaction: original, replayed: true, recordState: 'unchanged' };
        },
      },
    });
    operations.seed('ai_tool_calls', [{
      id: 'call-1', family_id: FAMILY, tool_name: 'finances.createTransaction', requested_by: 'auth-parent',
      requested_by_member_id: PARENT, actor_kind: 'ai', inputs,
    }]);
    const res = await createTransaction(
      { ...scope, toolOperation: { id: 'call-1', db: operations as unknown as ServiceScope['db'] } },
      { name: 'Trainers', amount: 64.5, merchant: 'Shoe Shop', memberId: EX },
    );
    expect(res).toMatchObject({ ok: true, data: { id: 'txn-1', member_id: EX, operation: { replayed: true } } });
  });
});
