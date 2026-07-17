import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PLA-0610 / LB-012 marketplace-integrity guard. `marketplace_place_bid_unchecked`
// is the RAW, SECURITY DEFINER auction-bid function that trusts its caller-supplied
// p_bidder_member_id / p_bidder_family_id WITHOUT verifying they belong to
// auth.uid() — it exists only to be called by the CHECKED `marketplace_place_bid`
// wrapper (which does that verification). Migration 0184 renamed the raw function
// (carrying its `authenticated` grant) and revoked only `public`, so `_unchecked`
// stayed executable by `authenticated` — letting any signed-in user place a bid as
// another family. 0220 revokes it from authenticated (service-role + the definer
// wrapper only). This test locks that so the grant can't silently come back.
const MIG = 'supabase/migrations/0220_revoke_place_bid_unchecked_from_authenticated.sql';

describe('marketplace_place_bid_unchecked is not executable by authenticated (0220)', () => {
  const raw = readFileSync(MIG, 'utf8');
  // Assert on executable SQL only — the header comment quotes the original buggy
  // grant while explaining the fix, and must not trip the "no re-grant" check.
  const sql = raw.replace(/^\s*--.*$/gm, '');

  it('revokes EXECUTE on _unchecked from authenticated', () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.marketplace_place_bid_unchecked\([^)]*\)\s+from\s+authenticated/i,
    );
  });

  it('re-asserts the revoke from public', () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.marketplace_place_bid_unchecked\([^)]*\)\s+from\s+public/i);
  });

  it('does NOT grant _unchecked back to authenticated (only service_role)', () => {
    expect(sql).not.toMatch(/grant[^;]*marketplace_place_bid_unchecked[^;]*to[^;]*authenticated/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.marketplace_place_bid_unchecked\([^)]*\)\s+to\s+service_role/i);
  });
});
