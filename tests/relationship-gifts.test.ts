import { describe, it, expect } from 'vitest';
import {
  suggestGiftsFromWishlist, buildRelationshipDigestPrompt, parseRelationshipDigest, summarizeGifts,
  buildRelationshipGiftHistory, matchesRecordedGift, RELATIONSHIP_GIFT_HISTORY_LIMIT,
  createRelationshipDigestRequestScope, type RelationshipDigestContext,
  type WishItemLite, type RelationshipGiftRecord,
} from '@/lib/relationship/gifts';

const item = (over: Partial<WishItemLite>): WishItemLite => ({
  id: 'i', title: 't', url: null, price: 20, priority: 'medium', is_purchased: false, claimed_by: null, ...over,
});

const recipient = { familyId: 'family-a', partnerMemberId: 'sam-id', partnerName: 'Sam Lee' };
const recorded = (over: Partial<RelationshipGiftRecord> = {}): RelationshipGiftRecord => ({
  id: 'gift-a', family_id: 'family-a', for_member_id: 'sam-id', for_name: 'Sam Lee',
  title: 'Travel mug', status: 'given', source: 'manual', wishlist_item_id: null, ...over,
});

describe('recorded relationship gift history', () => {
  it('retains real source identifiers, recipient associations, and distinct outcome statuses', () => {
    const given = recorded();
    const purchased = recorded({ id: 'gift-b', status: 'purchased', source: 'wishlist', wishlist_item_id: 'wish-b' });
    const history = buildRelationshipGiftHistory([given, purchased], recipient);
    expect(history.records).toEqual([
      { ...given, sourceTable: 'relationship_gift_ideas', matchedBy: 'member_id' },
      { ...purchased, sourceTable: 'relationship_gift_ideas', matchedBy: 'member_id' },
    ]);
    expect(history.summary).toContain('1 given, 1 purchased');
    expect(history.summary).toContain('reactions and other gift history remain unknown');
  });

  it('excludes other families, conflicting recipient IDs, missing recipients, and open ideas', () => {
    const history = buildRelationshipGiftHistory([
      recorded({ family_id: 'family-b' }),
      recorded({ for_member_id: 'someone-else', for_name: 'Sam Lee' }),
      recorded({ for_member_id: null, for_name: null }),
      recorded({ for_member_id: null, for_name: 'Samuel Lee' }),
      ...(['idea', 'saved', 'ordered'] as const).map((status) => recorded({ status })),
    ], recipient);
    expect(history.records).toEqual([]);
    expect(history.summary).toContain('No purchased or given gifts matched');
    expect(history.state).toBe('available');
  });

  it('uses normalized full names only when no recipient ID is recorded', () => {
    const history = buildRelationshipGiftHistory([
      recorded({ for_member_id: null, for_name: '  SAM  Lee  ' }),
      recorded({ id: 'conflict', for_member_id: 'someone-else', for_name: 'Sam Lee' }),
    ], recipient);
    expect(history.records.map((gift) => gift.id)).toEqual(['gift-a']);
    expect(history.records[0].matchedBy).toBe('name');
    expect(history.records[0].for_name).toBe('  SAM  Lee  ');
    expect(history.summary).toContain('a name match does not confirm identity');
  });

  it('does not guess a linked member from a name or a missing profile', () => {
    expect(buildRelationshipGiftHistory([recorded()], { ...recipient, partnerMemberId: null }).records).toEqual([]);
    expect(buildRelationshipGiftHistory([recorded()], { ...recipient, partnerMemberId: null, partnerName: ' ' }).state)
      .toBe('recipient_unknown');
    expect(buildRelationshipGiftHistory([recorded({ for_member_id: null })], { ...recipient, partnerName: null }).records)
      .toEqual([]);
    expect(buildRelationshipGiftHistory([recorded({ for_name: 'Old name' })], recipient).records).toHaveLength(1);
  });

  it('keeps a failed read unknown and an empty successful read limited to available records', () => {
    const failed = buildRelationshipGiftHistory(null, recipient);
    expect(failed.state).toBe('unavailable');
    expect(failed.records).toEqual([]);
    expect(failed.summary).toContain('unknown');
    const empty = buildRelationshipGiftHistory([], recipient);
    expect(empty.state).toBe('available');
    expect(empty.summary).toContain('other gift history remain unknown');
  });

  it('bounds history and discloses truncation even when the inspected rows belong to another recipient', () => {
    const rows = Array.from({ length: RELATIONSHIP_GIFT_HISTORY_LIMIT + 1 }, (_, i) => recorded({ id: `gift-${i}` }));
    const history = buildRelationshipGiftHistory(rows, recipient);
    expect(history.records).toHaveLength(RELATIONSHIP_GIFT_HISTORY_LIMIT);
    expect(history.truncated).toBe(true);
    expect(history.summary).toContain('100 most recently updated visible family outcomes');
    expect(buildRelationshipGiftHistory(rows.slice(0, -1), recipient).truncated).toBe(false);
    const unmatched = buildRelationshipGiftHistory(rows, { ...recipient, partnerMemberId: 'other' });
    expect(unmatched.records).toEqual([]);
    expect(unmatched.truncated).toBe(true);
  });

  it('uses exact normalized titles or wishlist IDs without inventing semantic equivalence', () => {
    const history = buildRelationshipGiftHistory([recorded({ wishlist_item_id: 'wish-a' })], recipient);
    expect(matchesRecordedGift({ title: '  TRAVEL\n mug ' }, history)).toBe(true);
    expect(matchesRecordedGift({ title: 'Renamed item', wishlistItemId: 'wish-a' }, history)).toBe(true);
    for (const title of ['Travel mugs', 'Travel-mug', 'Coffee cup', 'Travel mug accessories', '']) {
      expect(matchesRecordedGift({ title }, history)).toBe(false);
    }
    expect(matchesRecordedGift({ title: 'Travel mug' }, buildRelationshipGiftHistory(null, recipient))).toBe(false);
  });

  it('filters recorded wishlist gifts before ranking and limiting, retaining open ideas', () => {
    const history = buildRelationshipGiftHistory([
      recorded({ wishlist_item_id: 'renamed' }),
      recorded({ id: 'open', title: 'Sketchbook', status: 'idea' }),
    ], recipient);
    const result = suggestGiftsFromWishlist([
      item({ id: 'duplicate', title: ' TRAVEL MUG ', priority: 'high' }),
      item({ id: 'renamed', title: 'New title', priority: 'high' }),
      item({ id: 'new', title: 'Sketchbook' }),
    ], { giftHistory: history, limit: 1 });
    expect(result.map((gift) => gift.wishlistItemId)).toEqual(['new']);
  });

  it('supplies real history to the prompt and rejects duplicate output and fabricated model evidence', () => {
    const history = buildRelationshipGiftHistory([recorded()], recipient);
    const prompt = buildRelationshipDigestPrompt({
      partnerName: 'Sam Lee', upcoming: [], interests: [], loveLanguages: [],
      giftBudgetCents: null, wishlist: [], giftHistory: history,
    });
    expect(prompt.user).toContain(JSON.stringify(history));
    expect(prompt.system).toContain('given is not proof they liked it');
    const digest = parseRelationshipDigest(JSON.stringify({
      headline: 'Ideas', prompts: [], giftHistory: { records: [{ id: 'invented' }] },
      giftIdeas: [{ title: ' TRAVEL  MUG ', reason: 'duplicate' }, { title: 'Coffee cup', reason: 'different wording' }],
    }), history);
    expect(digest.giftIdeas.map((gift) => gift.title)).toEqual(['Coffee cup']);
    expect(digest.giftHistory).toEqual(history);
  });
});

describe('relationship digest request context and generations', () => {
  const context: RelationshipDigestContext = {
    familyId: 'family-a', userId: 'user-a', memberId: 'member-a',
    partnerMemberId: 'sam-id', partnerName: 'Sam Lee',
  };

  it('accepts only the current request with complete matching server context', () => {
    const scope = createRelationshipDigestRequestScope(context);
    const request = scope.begin();
    expect(scope.accepts(request, { ...context })).toBe(true);
    for (const invalid of [null, undefined, {}, [], 'family-a', { ...context, memberId: undefined }]) {
      expect(scope.accepts(request, invalid)).toBe(false);
    }
  });

  it.each(['familyId', 'userId', 'memberId', 'partnerMemberId', 'partnerName'] as const)(
    'rejects a response when its %s differs from the initiating context',
    (field) => {
      const scope = createRelationshipDigestRequestScope(context);
      const request = scope.begin();
      expect(scope.accepts(request, { ...context, [field]: 'changed' })).toBe(false);
      expect(scope.accepts(request, { ...context, [field]: null })).toBe(false);
    },
  );

  it('keeps unknown recipient fields explicitly null instead of accepting missing metadata', () => {
    const unknown = { ...context, partnerMemberId: null, partnerName: null };
    const scope = createRelationshipDigestRequestScope(unknown);
    const request = scope.begin();
    expect(scope.accepts(request, unknown)).toBe(true);
    expect(scope.accepts(request, { ...unknown, partnerName: undefined })).toBe(false);
    expect(scope.accepts(request, context)).toBe(false);
  });

  it('aborts and supersedes earlier same-context requests, including their error and loading cleanup guards', () => {
    const scope = createRelationshipDigestRequestScope(context);
    const older = scope.begin();
    const newer = scope.begin();
    expect(older.signal.aborted).toBe(true);
    expect(newer.signal.aborted).toBe(false);
    expect(newer.generation).toBeGreaterThan(older.generation);
    expect(scope.isCurrent(older)).toBe(false);
    expect(scope.accepts(older, context)).toBe(false);
    expect(scope.isCurrent(newer)).toBe(true);
    expect(scope.accepts(newer, context)).toBe(true);
  });

  it('invalidates pending and previously accepted results on context cleanup or unmount', () => {
    const scope = createRelationshipDigestRequestScope(context);
    const request = scope.begin();
    expect(scope.accepts(request, context)).toBe(true);
    scope.invalidate();
    expect(request.signal.aborted).toBe(true);
    expect(scope.isCurrent(request)).toBe(false);
    expect(scope.accepts(request, context)).toBe(false);
  });

  it('rejects an already-resolving response even if the transport ignores abort', async () => {
    const scope = createRelationshipDigestRequestScope(context);
    const request = scope.begin();
    let finish!: (value: RelationshipDigestContext) => void;
    const response = new Promise<RelationshipDigestContext>((resolve) => { finish = resolve; });
    const accepted = response.then((serverContext) => scope.accepts(request, serverContext));
    scope.invalidate();
    finish(context);
    expect(await accepted).toBe(false);
  });

  it('does not revive an old result when switching away and back to the same context', () => {
    const firstScope = createRelationshipDigestRequestScope(context);
    const oldRequest = firstScope.begin();
    firstScope.invalidate();
    const otherScope = createRelationshipDigestRequestScope({ ...context, familyId: 'family-b' });
    const otherRequest = otherScope.begin();
    otherScope.invalidate();
    const returnedScope = createRelationshipDigestRequestScope(context);
    const currentRequest = returnedScope.begin();
    expect(firstScope.isCurrent(oldRequest)).toBe(false);
    expect(returnedScope.accepts(oldRequest, context)).toBe(false);
    expect(otherScope.isCurrent(otherRequest)).toBe(false);
    expect(returnedScope.accepts(currentRequest, context)).toBe(true);
  });

  it('supports repeated lifecycle cleanup and a new request without reviving old generations', () => {
    const scope = createRelationshipDigestRequestScope(context);
    const oldRequest = scope.begin();
    scope.invalidate();
    scope.invalidate();
    const currentRequest = scope.begin();
    expect(scope.isCurrent(oldRequest)).toBe(false);
    expect(scope.accepts(currentRequest, context)).toBe(true);
  });

  it('snapshots the initiating context instead of following later mutation', () => {
    const mutableContext = { ...context };
    const scope = createRelationshipDigestRequestScope(mutableContext);
    const request = scope.begin();
    mutableContext.familyId = 'family-b';
    expect(scope.accepts(request, context)).toBe(true);
    expect(scope.accepts(request, mutableContext)).toBe(false);
  });
});

describe('suggestGiftsFromWishlist', () => {
  it('drops purchased/claimed, ranks by priority then price, normalizes to cents', () => {
    const out = suggestGiftsFromWishlist([
      item({ id: 'a', priority: 'low', price: 10 }),
      item({ id: 'b', priority: 'high', price: 80 }),
      item({ id: 'c', priority: 'high', price: 25 }),
      item({ id: 'd', is_purchased: true, priority: 'high' }),
      item({ id: 'e', claimed_by: 'u1', priority: 'high' }),
    ]);
    expect(out.map((g) => g.wishlistItemId)).toEqual(['c', 'b', 'a']);
    expect(out[0].priceCents).toBe(2500);
  });

  it('honors a max budget and a limit', () => {
    const out = suggestGiftsFromWishlist(
      [item({ id: 'a', price: 10 }), item({ id: 'b', price: 200 }), item({ id: 'c', price: 30 })],
      { maxBudgetCents: 5000, limit: 2 },
    );
    expect(out.map((g) => g.wishlistItemId)).toEqual(['a', 'c']);
  });

  it('keeps price-less items (unknown price passes the budget)', () => {
    const out = suggestGiftsFromWishlist([item({ id: 'a', price: null })], { maxBudgetCents: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].priceCents).toBeNull();
  });
});

describe('summarizeGifts', () => {
  it('splits open vs done and sums priced items', () => {
    expect(summarizeGifts([
      { status: 'idea', price_cents: 2500 },
      { status: 'ordered', price_cents: 1000 },
      { status: 'purchased', price_cents: 5000 },
      { status: 'given', price_cents: null },
      { status: 'saved', price_cents: null },
    ])).toEqual({ total: 5, open: 3, done: 2, openCents: 3500, spentCents: 5000 });
  });
  it('handles an empty list', () => {
    expect(summarizeGifts([])).toEqual({ total: 0, open: 0, done: 0, openCents: 0, spentCents: 0 });
  });
});

describe('buildRelationshipDigestPrompt', () => {
  it('includes upcoming dates, milestones, prefs, and wishlist', () => {
    const { system, user } = buildRelationshipDigestPrompt({
      partnerName: 'Sam',
      upcoming: [{ title: 'Anniversary', kind: 'anniversary', countdown: 'in 3 days', milestone: '5th anniversary' }],
      interests: ['hiking', 'coffee'],
      loveLanguages: ['quality time'],
      giftBudgetCents: 10000,
      wishlist: [{ title: 'Trail backpack', priceCents: 8500 }],
    });
    expect(system).toMatch(/STRUCTURED JSON only/);
    expect(user).toMatch(/Sam/);
    expect(user).toMatch(/5th anniversary/);
    expect(user).toMatch(/hiking, coffee/);
    expect(user).toMatch(/\$100/);       // budget
    expect(user).toMatch(/Trail backpack/);
  });

  it('degrades gracefully with no data', () => {
    const { user } = buildRelationshipDigestPrompt({
      partnerName: null, upcoming: [], interests: [], loveLanguages: [], giftBudgetCents: null, wishlist: [],
    });
    expect(user).toMatch(/your partner/);
    expect(user).toMatch(/no upcoming dates/);
  });
});

describe('parseRelationshipDigest', () => {
  it('parses a clean JSON payload', () => {
    const r = parseRelationshipDigest(JSON.stringify({
      headline: 'Your anniversary is coming up!',
      prompts: ['Book a table', '  ', 42],
      giftIdeas: [
        { title: 'Weekend cabin', reason: 'quality time', estimatedPrice: '$300' },
        { title: '', reason: 'skip me' },
      ],
    }));
    expect(r.headline).toBe('Your anniversary is coming up!');
    expect(r.prompts).toEqual(['Book a table']);
    expect(r.giftIdeas).toEqual([{ title: 'Weekend cabin', reason: 'quality time', estimatedPrice: '$300' }]);
  });

  it('extracts JSON wrapped in prose/code fences and tolerates junk', () => {
    const r = parseRelationshipDigest('Here you go:\n```json\n{"headline":"Hi","prompts":["a"],"giftIdeas":[]}\n```');
    expect(r.headline).toBe('Hi');
    expect(r.prompts).toEqual(['a']);
    expect(parseRelationshipDigest('not json').headline).toBe('');
  });
});
