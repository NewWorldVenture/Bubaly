// #771 comment 5984102159. The per-feature daily AI caps counted today's usage
// rows, called the model, and only then wrote the row that counts the call:
// N requests in flight together all read the same count and all reached the
// model. Each request that passes the count must now also win the atomic
// limiter key for the count it read, so racers that read the same count let
// exactly one through. The limiter is modelled as what `rate_limit_hit` is —
// one atomic counter per key — and every racer's count read is held until all
// of them have it, the interleaving a burst produces. Shown on the
// Relationship Helper; the Money Mentor and both Money Coach routes call the
// same admission (pinned below).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/ai/relationship/route';
import type { RelationshipGiftRecord } from '@/lib/relationship/gifts';
import { aiDailyAdmissionKey } from '@/lib/server/ai-daily-admission';
import { at } from './helpers/source-order';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), provider: vi.fn(), complete: vi.fn(), rate: vi.fn(), audit: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server, createServiceClient: () => ({ service: true }) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  describeAIError: (await importOriginal<typeof import('@/lib/ai/provider')>()).describeAIError,
  resolveProvider: mocks.provider,
  isAIConfigured: async () => true,
}));
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

const RELATIONSHIP_LIMIT = 20;
let hits: Map<string, number>;
let barrier: { size: number; waiting: number; release: (() => void) | null } | null;

/** `rate_limit_hit`, as the route sees it: one atomic counter per key. */
function atomicLimiter(_client: unknown, key: string, { limit }: { limit: number }) {
  const used = (hits.get(key) ?? 0) + 1;
  hits.set(key, used);
  return Promise.resolve(used <= limit ? { ok: true } : { ok: false, retryAfter: 30 });
}

/** The usage count, with every racer's read held until all of them have read it. */
function heldCountQuery(count: number) {
  return {
    select: () => heldCountQuery(count), eq: () => heldCountQuery(count), gte: () => heldCountQuery(count),
    then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const value = { data: null, error: null, count };
      const b = barrier;
      if (!b) return Promise.resolve(value).then(ok, ko);
      return (async () => {
        b.waiting += 1;
        if (b.waiting === b.size) b.release?.();
        else await new Promise<void>((r) => { const prev = b.release; b.release = () => { prev?.(); r(); }; });
        return value;
      })().then(ok, ko);
    },
  };
}

describe('the daily AI cap holds under concurrent requests', () => {
  beforeEach(() => {
    hits = new Map();
    barrier = null;
    mocks.rate.mockImplementation(atomicLimiter);
    mocks.server.mockResolvedValue({
      from: (table: string) => (table === 'audit_logs' ? heldCountQuery(RELATIONSHIP_LIMIT - 1) : new MockQuery(table)),
    });
  });

  it('three requests racing at 19 of 20 reach the model once', async () => {
    barrier = { size: 3, waiting: 0, release: null };
    const responses = await Promise.all([POST(), POST(), POST()]);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    expect(hits.get(aiDailyAdmissionKey('relationship_ai_digest', 'family-a', RELATIONSHIP_LIMIT - 1))).toBe(3);
  });

  it('control: one request under the cap is admitted and answered', async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('control: at the cap the count refuses before the admission or the model', async () => {
    mocks.server.mockResolvedValue({ from: (table: string) => (table === 'audit_logs' ? heldCountQuery(RELATIONSHIP_LIMIT) : new MockQuery(table)) });
    const response = await POST();
    expect(response.status).toBe(429);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect([...hits.keys()].some((k) => k.startsWith('ai-daily:'))).toBe(false);
  });
});

describe('every daily-capped AI route takes the admission for the rows it counts', () => {
  it.each([
    ['app/api/ai/invest/route.ts', "countedAction: 'ai_invest_call'"],
    ['app/api/ai/relationship/route.ts', 'countedAction: AI_AUDIT_ACTION'],
    ['app/api/ai/wallet/route.ts', "countedAction: 'ai_coach_call'"],
    ['app/api/ai/wallet/child/[childId]/route.ts', "countedAction: 'ai_coach_call'"],
  ])('%s', (file, needle) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(needle);
    // Admitted after the count refuses, and before any model call.
    expect(at(source, 'admitDailyAIUse({')).toBeGreaterThan(at(source, 'DailyLimitReached'));
    expect(at(source, 'admitDailyAIUse({')).toBeLessThan(at(source, 'provider.complete('));
  });
});
