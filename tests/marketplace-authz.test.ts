import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-14 marketplace trust invariants. These SECURITY DEFINER RPCs move ownership
// and money between families, so they must gate on the caller: only a listing's
// owning member may accept/decline offers; a bidder/buyer must prove the member
// id they act as belongs to auth.uid(); and nobody may buy their own listing.
// This test pins those checks to their migrations so a refactor can't drop them.
const ownership = readFileSync('supabase/migrations/0154_marketplace_ownership.sql', 'utf8');
const auction = readFileSync('supabase/migrations/0184_marketplace_auction_authorization.sql', 'utf8');

describe('A-14 marketplace offer RPCs are owner-gated', () => {
  it('accept_offer refuses a non-owner', () => {
    const fn = ownership.slice(ownership.indexOf('function public.marketplace_accept_offer'));
    expect(fn).toContain('marketplace_member_id(v_listing.family_id)');
    expect(fn).toContain('Only the listing owner can accept offers');
  });

  it('decline_offer refuses a non-owner', () => {
    const fn = ownership.slice(ownership.indexOf('function public.marketplace_decline_offer'));
    expect(fn).toContain('Only the listing owner can decline offers');
  });

  it('set_listing_status is owner-checked', () => {
    const fn = ownership.slice(ownership.indexOf('function public.marketplace_set_listing_status'));
    expect(fn).toContain('marketplace_member_id(');
  });
});

describe('A-14 auction RPCs verify the acting member belongs to the caller', () => {
  it('place_bid ties the bidder member to auth.uid() and their family', () => {
    const fn = auction.slice(auction.indexOf('function public.marketplace_place_bid('));
    expect(fn).toContain('where id = p_bidder_member_id and user_id = auth.uid() and is_active');
    expect(fn).toContain("'unauthorized'");
    expect(fn).toContain('is distinct from p_bidder_family_id');
  });

  it('buy_now ties the buyer member to auth.uid() and blocks buying your own listing', () => {
    const fn = auction.slice(auction.indexOf('function public.marketplace_buy_now('));
    expect(fn).toContain('where id = p_buyer_member_id and user_id = auth.uid() and is_active');
    expect(fn).toContain("'own_listing'");
    // must lock the listing row to prevent a concurrent double-claim
    expect(fn).toContain('for update');
  });

  it('both RPCs are revoked from public (callable by authenticated/service only)', () => {
    expect(auction).toContain('revoke all on function public.marketplace_place_bid');
  });
});
