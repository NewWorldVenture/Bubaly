import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/ai/relationship/route';
import type { RelationshipGiftRecord } from '@/lib/relationship/gifts';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), provider: vi.fn(), complete: vi.fn(), rate: vi.fn(), audit: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.provider }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.rate }));
vi.mock('@/lib/server/audit', () => ({ logAudit: mocks.audit }));

type QueryResult = { data: unknown; error: { message: string; code?: string } | null; count?: number };
const queries: { table: string; operations: unknown[][] }[] = [];
let results: Record<string, QueryResult>;

class MockQuery implements PromiseLike<QueryResult> {
  private operations: unknown[][] = [];
  constructor(private table: string) { queries.push({ table, operations: this.operations }); }
  private record(method: string, args: unknown[]) { this.operations.push([method, ...args]); return this; }
  select(...args: unknown[]) { return this.record('select', args); }
  eq(...args: unknown[]) { return this.record('eq', args); }
  neq(...args: unknown[]) { return this.record('neq', args); }
  gte(...args: unknown[]) { return this.record('gte', args); }
  in(...args: unknown[]) { return this.record('in', args); }
  order(...args: unknown[]) { return this.record('order', args); }
  limit(...args: unknown[]) { return this.record('limit', args); }
  maybeSingle() { return this.record('maybeSingle', []); }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(results[this.table]).then(onfulfilled, onrejected);
  }
}

const record = (over: Partial<RelationshipGiftRecord> = {}): RelationshipGiftRecord => ({
  id: 'given-id', family_id: 'family-a', for_member_id: 'sam-id', for_name: 'Sam', title: 'Travel mug',
  status: 'given', source: 'wishlist', wishlist_item_id: 'linked-wish', ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  queries.length = 0;
  // `role` and `family` are what `scopeFromUserContext` reads to build the
  // service scope the route now opens its `ai_requests` row through. They are
  // required fields on `FamilyMembership`, so production always has them; this
  // stub was simply thinner than the type.
  mocks.context.mockResolvedValue({
    user: { id: 'user-a' },
    active: {
      familyId: 'family-a', role: 'parent',
      family: { name: 'Family A', timezone: 'America/Chicago' },
      member: { id: 'member-a' },
    },
  });
  mocks.server.mockResolvedValue({ from: (table: string) => new MockQuery(table) });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.provider.mockResolvedValue({ complete: mocks.complete });
  mocks.complete.mockResolvedValue({ text: JSON.stringify({
    headline: 'Gift suggestions', prompts: [], giftHistory: { records: [{ id: 'fabricated' }] },
    context: { familyId: 'model-invented-family', memberId: 'model-invented-member' },
    giftIdeas: [' TRAVEL  MUG ', 'Coffee grinder', 'Scarf', 'Sketchbook'].map((title) => ({ title, reason: 'Synthetic idea' })),
  }) });
  results = {
    audit_logs: { data: null, error: null, count: 0 },
    relationship_profile: { data: {
      partner_name: 'Sam', partner_member_id: 'sam-id', interests: [], love_languages: [], gift_budget_cents: null,
    }, error: null },
    relationship_dates: { data: [], error: null },
    relationship_gift_ideas: { data: [
      record(),
      record({ id: 'purchased-id', title: 'Coffee grinder', status: 'purchased', for_member_id: null, for_name: ' SAM ', wishlist_item_id: null }),
      record({ id: 'other-recipient', for_member_id: 'other-id', for_name: 'Sam', title: 'Scarf' }),
      record({ id: 'foreign-family', family_id: 'family-b', title: 'Private foreign gift' }),
      record({ id: 'open-idea', status: 'idea', title: 'Sketchbook' }),
    ], error: null },
    wishlist_items: { data: [
      { id: 'linked-wish', title: 'Renamed travel cup', url: null, price: 20, priority: 'high', is_purchased: false, claimed_by: null },
      { id: 'new-wish', title: 'Sketchbook', url: null, price: 10, priority: 'medium', is_purchased: false, claimed_by: null },
    ], error: null },
  };
});
afterEach(() => vi.restoreAllMocks());

describe('relationship digest recorded gift outcomes', () => {
  it('uses the active-family user client, bounded real outcomes, and server-owned evidence', async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    const { digest, context } = await response.json();
    expect(context).toEqual({
      familyId: 'family-a', userId: 'user-a', memberId: 'member-a',
      partnerMemberId: 'sam-id', partnerName: 'Sam',
    });
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.server).toHaveBeenCalledOnce();
    const historyQuery = queries.find((query) => query.table === 'relationship_gift_ideas');
    expect(historyQuery?.operations).toEqual([
      ['select', 'id, family_id, for_member_id, for_name, title, status, source, wishlist_item_id'],
      ['eq', 'family_id', 'family-a'], ['in', 'status', ['purchased', 'given']],
      ['order', 'updated_at', { ascending: false }], ['order', 'id', { ascending: true }], ['limit', 101],
    ]);
    expect(queries.find((query) => query.table === 'wishlist_items')?.operations)
      .toEqual(expect.arrayContaining([['eq', 'family_id', 'family-a'], ['eq', 'member_id', 'sam-id']]));
    expect(digest.giftHistory.records).toEqual([
      expect.objectContaining({ id: 'given-id', family_id: 'family-a', for_member_id: 'sam-id', status: 'given', sourceTable: 'relationship_gift_ideas', source: 'wishlist', wishlist_item_id: 'linked-wish', matchedBy: 'member_id' }),
      expect.objectContaining({ id: 'purchased-id', for_member_id: null, for_name: ' SAM ', status: 'purchased', matchedBy: 'name' }),
    ]);
    expect(digest.giftIdeas.map((gift: { title: string }) => gift.title)).toEqual(['Scarf', 'Sketchbook']);
    const request = mocks.complete.mock.calls[0][0];
    expect(request.messages[0].content).toContain('given-id');
    expect(request.messages[0].content).toContain('purchased-id');
    for (const excluded of ['other-recipient', 'foreign-family', 'open-idea', 'Renamed travel cup']) {
      expect(request.messages[0].content).not.toContain(excluded);
    }
    expect(request.tools).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it('supports recorded names without guessing a member ID', async () => {
    results.relationship_profile.data = { partner_name: 'Sam', partner_member_id: null };
    const response = await POST();
    const { digest, context } = await response.json();
    expect(context).toEqual({
      familyId: 'family-a', userId: 'user-a', memberId: 'member-a',
      partnerMemberId: null, partnerName: 'Sam',
    });
    expect(response.status).toBe(200);
    expect(digest.giftHistory.records.map((gift: { id: string }) => gift.id)).toEqual(['purchased-id']);
    expect(digest.giftHistory.summary).toContain('a name match does not confirm identity');
    expect(queries.some((query) => query.table === 'wishlist_items')).toBe(false);
    expect(digest.giftIdeas.map((gift: { title: string }) => gift.title)).toContain('TRAVEL  MUG');
  });

  it.each(['42P01', '42501'])('keeps failed history unknown (%s), ignoring any accompanying data', async (code) => {
    results.relationship_gift_ideas.error = { code, message: 'Synthetic read failure' };
    const response = await POST();
    const { digest } = await response.json();
    expect(response.status).toBe(200);
    expect(digest.giftHistory.state).toBe('unavailable');
    expect(digest.giftHistory.records).toEqual([]);
    expect(digest.giftHistory.summary).toContain('unknown');
    expect(digest.giftIdeas).toHaveLength(4);
    expect(mocks.complete.mock.calls[0][0].messages[0].content).not.toContain('given-id');
  });

  it('does not read gift history when the recipient is unknown', async () => {
    results.relationship_profile.data = null;
    const response = await POST();
    const { digest, context } = await response.json();
    expect(context).toEqual({
      familyId: 'family-a', userId: 'user-a', memberId: 'member-a',
      partnerMemberId: null, partnerName: null,
    });
    expect(response.status).toBe(200);
    expect(digest.giftHistory.state).toBe('recipient_unknown');
    expect(digest.giftHistory.records).toEqual([]);
    expect(queries.some((query) => query.table === 'relationship_gift_ideas')).toBe(false);
  });

  it('explains an empty successful read without claiming the recipient has never received gifts', async () => {
    results.relationship_gift_ideas.data = [];
    const response = await POST();
    const { digest } = await response.json();
    expect(digest.giftHistory.state).toBe('available');
    expect(digest.giftHistory.summary).toContain('No purchased or given gifts matched');
    expect(digest.giftHistory.summary).toContain('other gift history remain unknown');
  });

  it('discloses the bounded window and excludes the extra sentinel record from evidence and the prompt', async () => {
    results.relationship_gift_ideas.data = Array.from({ length: 101 }, (_, i) => record({ id: `bounded-${i}`, title: `Gift ${i}` }));
    const response = await POST();
    const { digest } = await response.json();
    expect(digest.giftHistory.truncated).toBe(true);
    expect(digest.giftHistory.records).toHaveLength(100);
    expect(digest.giftHistory.summary).toContain('100 most recently updated visible family outcomes');
    expect(mocks.complete.mock.calls[0][0].messages[0].content).not.toContain('bounded-100');
  });

  it('does not read history or resolve a provider without user context', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.context.mockRejectedValue(new Error('Synthetic unauthenticated request'));
    expect((await POST()).status).toBe(500);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('retains the existing explicit-request rate limit before any history read or completion', async () => {
    mocks.rate.mockResolvedValue({ ok: false, retryAfter: 30 });
    const response = await POST();
    expect(response.status).toBe(429);
    expect(queries).toEqual([]);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
