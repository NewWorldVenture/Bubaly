import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCircleFeed, circleStats, formatJoinCode, isValidJoinCode,
  normalizeJoinCode, shareableListings,
  type CircleMemberLite, type ShareLite, type SharedListingLite,
} from '@/lib/marketplace/community';

const MEMBERS: CircleMemberLite[] = [
  { circle_id: 'c1', family_id: 'fam-a', family_name: 'The Andersons', role: 'owner' },
  { circle_id: 'c1', family_id: 'fam-b', family_name: 'The Baileys', role: 'member' },
  { circle_id: 'c2', family_id: 'fam-a', family_name: 'The Andersons', role: 'member' },
];

const LISTINGS: SharedListingLite[] = [
  { id: 'l1', title: 'Balance bike', kind: 'sell', category: 'toys', condition: 'good', price_cents: 4000, status: 'available', family_id: 'fam-a' },
  { id: 'l2', title: 'Winter coats', kind: 'free', category: 'clothing', condition: 'good', price_cents: 0, status: 'available', family_id: 'fam-b' },
  { id: 'l3', title: 'Sold desk', kind: 'sell', category: 'furniture', condition: 'good', price_cents: 2000, status: 'completed', family_id: 'fam-b' },
];

const SHARES: ShareLite[] = [
  { listing_id: 'l1', circle_id: 'c1', family_id: 'fam-a', created_at: '2026-07-10T10:00:00Z' },
  { listing_id: 'l2', circle_id: 'c1', family_id: 'fam-b', created_at: '2026-07-12T10:00:00Z' },
  { listing_id: 'l3', circle_id: 'c1', family_id: 'fam-b', created_at: '2026-07-11T10:00:00Z' },
];

describe('join codes', () => {
  it('normalizes, formats, validates', () => {
    expect(normalizeJoinCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(formatJoinCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(isValidJoinCode('abcd-efgh')).toBe(true);
    expect(isValidJoinCode('abc')).toBe(false);
  });

  // `marketplace_create_circle` promised "no 0/O/1/I" but ran `translate`
  // before `upper` with only the uppercase letters in its from-set, so a
  // lowercase `o` or `i` came back out as `O` or `I`. Measured: 22.8% of codes.
  // 0314 fixes the generator AND teaches the lookup to read a typed digit as
  // the letter, because the codes already issued cannot be rotated.
  it('reads a typed 0 as O and a typed 1 as I, the way the SQL does', () => {
    expect(normalizeJoinCode('0IVWXYZA')).toBe('OIVWXYZA');
    expect(normalizeJoinCode('o1vwxyza')).toBe('OIVWXYZA');
    expect(normalizeJoinCode('01vwxyza')).toBe('OIVWXYZA');
    // Unambiguous precisely because a stored code can never hold a 0 or a 1.
    expect(normalizeJoinCode('OIVWXYZA')).toBe('OIVWXYZA');
  });

  it('keeps displaying a stored code unchanged', () => {
    // Stored codes carry no digits 0 or 1, so the mapping is a no-op on
    // display — a circle's code must not render as something else.
    for (const stored of ['OIVWXYZA', 'ABCDEFGH', 'ZY23KLMN', 'JKLMNPQR']) {
      expect(formatJoinCode(stored).replace('-', '')).toBe(stored);
    }
  });

  it('agrees with the SQL, character for character', () => {
    // The two copies drifted apart once already in this repository (the
    // document classifier). Pin them: this is `translate(upper(trim(p_code)),
    // '01', 'OI')` read out of the migration and applied here.
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/0314_circle_join_codes_are_unambiguous.sql'), 'utf8');
    expect(sql).toContain("translate(upper(trim(p_code)), '01', 'OI')");
    // And the generator's from-set names both cases of every ambiguous letter.
    const fromSet = sql.match(/translate\(encode\(gen_random_bytes\(8\), 'base64'\),\s*'([^']+)'/)?.[1];
    expect(fromSet, 'the generator from-set').toBeDefined();
    for (const ch of ['0', 'O', '1', 'I', 'l', 'o', 'i']) {
      expect(fromSet, `from-set is missing ${ch}`).toContain(ch);
    }
  });
});

describe('shareableListings', () => {
  it('offers only my own, available, not-yet-shared listings', () => {
    const mine: { id: string; family_id: string; status: string }[] = [
      { id: 'l1', family_id: 'fam-a', status: 'available' },   // already shared into c1
      { id: 'l4', family_id: 'fam-a', status: 'available' },   // shareable
      { id: 'l5', family_id: 'fam-a', status: 'completed' },   // not available
      { id: 'l6', family_id: 'fam-b', status: 'available' },   // not mine
    ];
    const out = shareableListings(mine, 'fam-a', 'c1', SHARES);
    expect(out.map((l) => l.id)).toEqual(['l4']);
    // Same listing IS shareable into a different circle.
    expect(shareableListings(mine, 'fam-a', 'c2', SHARES).map((l) => l.id)).toEqual(['l1', 'l4']);
  });
});

describe('buildCircleFeed', () => {
  it('attributes via the roster, hides completed items, sorts newest-share first', () => {
    const feed = buildCircleFeed('c1', SHARES, LISTINGS, MEMBERS, 'fam-a');
    expect(feed.map((f) => f.listing.id)).toEqual(['l2', 'l1']); // l3 completed → hidden
    expect(feed[0].fromFamily).toBe('The Baileys');
    expect(feed[0].isMine).toBe(false);
    expect(feed[1].fromFamily).toBe('The Andersons');
    expect(feed[1].isMine).toBe(true);
  });

  it('falls back gracefully for unknown sharers and missing listings', () => {
    const feed = buildCircleFeed(
      'c1',
      [{ listing_id: 'l2', circle_id: 'c1', family_id: 'fam-zz', created_at: '2026-07-12T10:00:00Z' },
       { listing_id: 'gone', circle_id: 'c1', family_id: 'fam-a', created_at: '2026-07-12T11:00:00Z' }],
      LISTINGS, MEMBERS, 'fam-a',
    );
    expect(feed).toHaveLength(1);
    expect(feed[0].fromFamily).toBe('A family');
  });
});

describe('circleStats', () => {
  it('counts families, shared items, and items from other families', () => {
    const feed = buildCircleFeed('c1', SHARES, LISTINGS, MEMBERS, 'fam-a');
    const stats = circleStats('c1', MEMBERS, feed);
    expect(stats).toEqual({ families: 2, shared: 2, fromOthers: 1 });
  });
});
