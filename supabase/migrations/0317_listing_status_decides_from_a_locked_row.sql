-- Bubaly :: 0317 - the listing state machine decides from a locked row
--
-- `marketplace_set_listing_status` is the seller's state machine: withdraw,
-- complete, relist, mark pending. It reads the listing, decides whether the
-- transition is legal, and writes:
--
--   select * into v_listing from public.marketplace_listings where id = p_listing;
--   ...
--   v_ok := case when p_status = 'withdrawn' then v_listing.status in (...) ... end;
--   if not v_ok then raise exception 'Cannot move listing from % to %', ...; end if;
--   update public.marketplace_listings set status = p_status, updated_at = now()
--    where id = v_listing.id;
--
-- The read takes no lock and the write carries no predicate, so the decision is
-- made against a row that another transaction may already have changed. Of the
-- twenty-two SECURITY DEFINER functions in this schema that read a row and then
-- update it, this was the ONLY one with neither — every other one takes
-- `for update`, predicates its write, or both.
--
-- ── measured, with two real concurrent sessions ────────────────────────────
--
-- The transition that exposes it is one the state machine FORBIDS:
--
--   when p_status = 'pending' then v_listing.status = 'available'
--
-- so `claimed -> pending` is illegal. Session A (a buyer) calls
-- `marketplace_buy_now`, which does everything right: `select ... for update`,
-- a status check, and an UPDATE predicated on `status = 'available'`. Session B
-- (the seller) calls `marketplace_set_listing_status(listing, 'pending')` while
-- A is still open.
--
--   before:  seller: (no error — the forbidden transition was accepted)
--            listing=pending  claimed_by=<buyer>  confirmed_orders=1
--
--   after:   seller: ERROR: Cannot move listing from claimed to pending
--            listing=claimed  claimed_by=<buyer>  confirmed_orders=1
--
-- B read `available`, decided `available -> pending` was legal against that
-- stale value, then blocked on A's row lock and wrote anyway. The listing goes
-- back on the market as `pending` while carrying a confirmed order and the
-- buyer's `claimed_by` — a second buyer can now be pointed at an item that is
-- already sold.
--
-- `buy_now` is not at fault. It took the lock. The other function walked around
-- it by never asking for one.
--
-- A NOTE ON WHAT THIS IS NOT: `claimed -> withdrawn` is legal from both the
-- stale and the fresh read, so a seller withdrawing a listing that was just
-- claimed is NOT this defect — it is the product working as designed, and the
-- probe asserts it still does. Only a transition the state machine rejects
-- from the true status shows the stale read.
--
-- ── the fix ────────────────────────────────────────────────────────────────
--
-- Take the lock on the read, the way the other twenty-one do, so the transition
-- is decided against the row as it will be written. The UPDATE also carries the
-- status it was decided from, and a zero-row result is reported rather than
-- swallowed — belt and braces, because the whole finding is that one mechanism
-- silently absent is enough.
--
-- Note `claimed -> withdrawn` remains legal and deliberately so: a seller whose
-- buyer falls through must be able to pull the listing. What changes is that the
-- decision can no longer be made against a listing that was claimed in the
-- meantime.

create or replace function public.marketplace_set_listing_status(p_listing uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_ok      boolean;
  v_changed uuid;
begin
  -- `for update` is the whole fix: it makes the row this function decides from
  -- the same row it writes to.
  select * into v_listing from public.marketplace_listings where id = p_listing for update;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can change this listing';
  end if;

  v_ok := case
    when p_status = 'withdrawn'  then v_listing.status in ('available','pending','claimed')
    when p_status = 'completed'  then v_listing.status in ('claimed','pending')
    when p_status = 'available'  then v_listing.status in ('pending','withdrawn')
    when p_status = 'pending'    then v_listing.status = 'available'
    else false
  end;
  if not v_ok then
    raise exception 'Cannot move listing from % to %', v_listing.status, p_status;
  end if;

  update public.marketplace_listings set status = p_status, updated_at = now()
   where id = v_listing.id
     and status = v_listing.status
  returning id into v_changed;
  -- Unreachable while the lock above is held, and asserted anyway: if the lock
  -- is ever dropped from this function, this is what stops the write landing
  -- against a status nobody checked.
  if v_changed is null then
    raise exception 'Cannot move listing from % to %', v_listing.status, p_status;
  end if;
end $$;

comment on function public.marketplace_set_listing_status(uuid, text) is
  'Moves a listing through the seller state machine. Reads FOR UPDATE and predicates the write on the status it decided from, so a listing cannot be withdrawn out from under a concurrent buy-now or offer acceptance (0317).';
