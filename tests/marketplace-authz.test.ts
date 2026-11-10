import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-14 marketplace trust invariants. These SECURITY DEFINER RPCs move ownership
// and money between families, so they must gate on the caller: only a listing's
// owning member may accept/decline offers; a bidder/buyer must prove the member
// id they act as belongs to auth.uid(); and nobody may buy their own listing.
// This test pins those checks to their migrations so a refactor can't drop them.
const ownership = readFileSync('supabase/migrations/0154_marketplace_ownership.sql', 'utf8');
const auction = readFileSync('supabase/migrations/0184_marketplace_auction_authorization.sql', 'utf8');
// The definitions the database runs today: 0317 re-created set_listing_status,
// and 0483 re-created both auction RPCs and re-stated their grants.
const liveListingStatus = readFileSync('supabase/migrations/0317_listing_status_decides_from_a_locked_row.sql', 'utf8');
const liveAuction = readFileSync('supabase/migrations/0483_a_live_hold_counts_and_an_order_names_both_families.sql', 'utf8');

/** One function's own definition: from its `create` line to the `$$;` / `$function$;` that closes it. */
function definitionOf(sql: string, header: string): string {
  const start = sql.indexOf(header);
  expect(start, header).toBeGreaterThan(-1);
  const end = sql.slice(start).search(/\$(function)?\$;/);
  expect(end, `${header} is closed`).toBeGreaterThan(-1);
  return sql.slice(start, start + end);
}

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
    // The slice above runs to the end of the file, where the grants and every
    // RLS policy also say `marketplace_member_id(`. The check has to be inside
    // the function itself, in 0154 and in the definition that replaced it.
    for (const sql of [ownership, liveListingStatus]) {
      const body = definitionOf(sql, 'create or replace function public.marketplace_set_listing_status(');
      expect(body).toContain('v_caller := public.marketplace_member_id(v_listing.family_id);');
      expect(body).toContain('if v_caller is null or v_listing.member_id is distinct from v_caller then');
      expect(body).toContain("raise exception 'Only the listing owner can change this listing';");
      // refused before the row is written
      expect(body.indexOf('Only the listing owner can change this listing')).toBeLessThan(body.indexOf('update public.marketplace_listings'));
    }
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
    // That prefix is also the start of the `marketplace_place_bid_unchecked`
    // revoke, and says nothing of buy_now: name both signatures in full.
    expect(auction).toContain('revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public;');
    expect(auction).toContain('revoke all on function public.marketplace_buy_now(uuid, uuid, uuid) from public;');
    // 0483 re-created both functions, which is when a grant has to be re-stated.
    expect(liveAuction).toContain('revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public, anon;');
    expect(liveAuction).toContain('revoke all on function public.marketplace_buy_now(uuid, uuid, uuid) from public, anon;');
  });
});
