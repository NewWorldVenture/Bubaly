import { describe, it, expect } from 'vitest';
import {
  requestToMatchRequest, listingRowToMatchListing, matchToInsert, saveRequestMatches,
} from '@/lib/marketplace/matching-server';

describe('pure mappers', () => {
  it('maps a request row into a MatchRequest (mode normalized)', () => {
    const mr = requestToMatchRequest({
      title: 'Black dress', item_type: 'clothing', preferred_mode: 'rent', size: 'M', color: 'black',
      brand: 'Zara', condition: null, budget_cents: 5000, radius_miles: 25, description: null,
    } as never);
    expect(mr.preferredMode).toBe('rent');
    expect(mr.itemType).toBe('clothing');
    expect(mr.budgetCents).toBe(5000);
  });

  it('drops an unknown preferred_mode', () => {
    expect(requestToMatchRequest({ title: 't', preferred_mode: 'weird' } as never).preferredMode).toBeUndefined();
  });

  it('maps a listing row and builds a match insert', () => {
    const ml = listingRowToMatchListing({ id: 'l1', title: 'Dress', category: 'clothing', modes: ['rent'], price_cents: 3000, status: 'available', visibility: 'public' } as never);
    expect(ml.priceCents).toBe(3000);
    const insert = matchToInsert('fam', 'req', { listing: ml, score: 82, reasons: ['size M', 'brand Zara'], distanceMiles: null });
    expect(insert).toMatchObject({ family_id: 'fam', request_id: 'req', listing_id: 'l1', score: 82, status: 'suggested' });
    expect(insert.reason).toBe('size M · brand Zara');
  });
});

// Fake DB: request via maybeSingle, listings via awaited chain, matches delete+insert captured.
function makeFake(rows: Record<string, unknown>) {
  const ops: { table: string; op: string; rows?: unknown }[] = [];
  const db = {
    ops,
    from(table: string) {
      let op = 'select';
      let payload: unknown;
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b, in: () => b, is: () => b, limit: () => b,
        delete: () => { op = 'delete'; return b; },
        insert: (r: unknown) => { op = 'insert'; payload = r; return b; },
        maybeSingle: () => Promise.resolve({ data: rows[table] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) => {
          if (op === 'insert') ops.push({ table, op, rows: payload });
          else if (op === 'delete') ops.push({ table, op });
          return resolve({ data: Array.isArray(rows[table]) ? rows[table] : [], error: null });
        },
      };
      return b;
    },
  };
  return db;
}
const asDb = (d: ReturnType<typeof makeFake>) => d as never;

describe('saveRequestMatches', () => {
  const request = { id: 'req1', family_id: 'fam', title: 'black dress', item_type: 'clothing', preferred_mode: 'rent', size: 'M', color: 'black', brand: 'Zara', condition: null, budget_cents: 6000, radius_miles: null, description: null };
  const listings = [
    { id: 'match', title: 'Black dress', category: 'clothing', modes: ['rent'], size: 'M', color: 'black', brand: 'Zara', condition: null, price_cents: 3000, latitude: null, longitude: null, status: 'available', visibility: 'public' },
    { id: 'wrong-mode', title: 'Black dress', category: 'clothing', modes: ['buy'], price_cents: 3000, status: 'available', visibility: 'public' },
  ];

  it('computes, clears, and inserts matches for the request', async () => {
    const db = makeFake({ marketplace_requests: request, marketplace_listings: listings });
    const res = await saveRequestMatches(asDb(db), 'req1');
    expect(res.matches[0].listing.id).toBe('match');
    expect(res.saved).toBe(res.matches.length);
    // A delete on matches precedes the insert (idempotent rewrite).
    const matchOps = db.ops.filter((o) => o.table === 'marketplace_request_matches');
    expect(matchOps[0].op).toBe('delete');
    expect(matchOps[1].op).toBe('insert');
    const inserted = matchOps[1].rows as { listing_id: string }[];
    expect(inserted.map((r) => r.listing_id)).toContain('match');
    expect(inserted.map((r) => r.listing_id)).not.toContain('wrong-mode'); // rent request
  });

  it('no-ops when the request is gone', async () => {
    const db = makeFake({ marketplace_requests: null });
    const res = await saveRequestMatches(asDb(db), 'nope');
    expect(res).toEqual({ matches: [], saved: 0 });
    expect(db.ops).toEqual([]);
  });
});
