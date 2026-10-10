-- Bubaly :: 0483 - a live hold counts against the spend, and an order names
--                   both families
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 family-economy audit (proposed-economy.sql: the economy
-- and marketplace halves the app-layer fix 47919df02 could not close; tested on
-- PG16 with all 451 migrations replayed, idempotent on a second run). Numbered
-- 0483 by owner decision of 2026-10-10; the SQL is the proposal's, unchanged.
--
-- Probe: docs/audit/a-live-hold-counts-and-an-order-names-both-families-check.sql. Each
-- forbidden case there succeeds on 0476 and is refused after this file; each
-- allowed case passes on both. Five existing probes carry fixture or expectation
-- edits for what this changes on purpose (see the header of each):
-- a-listing-is-acted-on-only-by-who-can-see-it-check, proxy-bid-ceiling-is-secret-check,
-- gift-money-route-check, money-decision-rows-check, wallet-side-table-write-check.
--
-- The app half (audit/economy-fix, 2a6d36282) reads orders as either party and
-- other families' listings through marketplace_circle_listings, and works on
-- both schemas (it falls back on 42703/PGRST204 and PGRST205/42P01).
--
-- What it closes, one section each:
--
--   1  HIGH  wallet_decide_spend and wallet_transfer (0205) totalled only
--            'completed' rows. A live card hold ('processing') was invisible to
--            them, so a $10 Spend bucket with an $8 hold still let a parent
--            approve an $8 spend or send $8 to a sibling. The card capture then
--            took the ledger to -$6. Both now call one helper,
--            wallet_spendable_cents, which counts ('completed','processing') the
--            same way 0155 and 0342 do. Both still call it under the existing
--            bucket row lock.
--   2  HIGH  Orders from marketplace_close_auction (0457), marketplace_buy_now
--            (0462) and negotiation accept (0186) stored only the SELLER's
--            family_id. The winner is always from another family, so it could
--            not read its order, propose or confirm the pickup, or complete it.
--            This adds marketplace_orders.buyer_family_id: set on insert,
--            backfilled, and immutable. The parties' SELECT, UPDATE and handoff
--            access then accepts either family, and the seller family keeps
--            everything it had.
--   3        marketplace_complete_handoff (0199) checked family membership only:
--            any sibling who could read confirm_code could close someone else's
--            pickup. It now requires the caller to be buyer_member or
--            seller_member. Handoff rows, including confirm_code, are readable
--            by the two parties only.
--   4        invest_orders INSERT checked is_family_member only, so a child could
--            queue a sell of a sibling's shares. A RESTRICTIVE policy now
--            requires a manager or the wallet's own member, and 0311's
--            reference_shares_family is wired on child_wallet_id.
--   5        Proxy bidding. (a) When the leading household raises its max, only
--            the hidden max changes: no price rise against itself, no 'outbid',
--            no bid_count bump, no anti-snipe extension. (b) When the leader's
--            max covers the reserve, the visible price is raised to the reserve.
--            (c) close decides "sold" on highest_max_cents >= reserve and
--            settles at greatest(current_bid_cents, reserve_cents).
--   6        marketplace_buy_now refuses once ANY bid exists (bid_count > 0),
--            the same rule as buyNowClosedByBids in lib/marketplace/auction.ts.
--   7        Role gates: bidding, Buy-It-Now, making an offer, countering or
--            accepting in a negotiation, creating or joining a circle, and
--            sharing a listing into a circle all need can_manage_family (role
--            in 'parent','adult'). That is exactly MANAGER_ROLES / isManager()
--            in lib/constants/roles.ts, the rule 47919df02 applies.
--   8        Circles: an owner-only remove-and-block RPC, unblock, join-code
--            rotation, a block check in join, and a feed view that replaces the
--            whole-row circle read on marketplace_listings.
--   9        gift_payments SELECT is limited to managers: a pending gift's
--            giver_name and message are an outsider's free text.
--
-- DEPLOY ORDER (owner decision): sections 2 and 8c change what the CURRENT app
-- reads. Ship them with the app changes listed in the proposal report:
--   * orders page and loadOrderRole must stop filtering
--     .eq('family_id', active family) and read
--     family_id OR buyer_family_id = active family;
--   * cross-family listing reads (community feed, auctions page, auction panel,
--     placeBid/buyNow pre-reads) move to public.marketplace_circle_listings.
-- Sections 1, 3, 4, 5, 6, 7 and 9 are safe with the code at 47919df02 as it is.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. One spendable balance for the Spend bucket
-- ════════════════════════════════════════════════════════════════════════════
--
-- 0155 (card authorisation) and 0342 (wallet_debit_spend_bucket) already count
-- ('completed','processing'). This helper is the same sum, in one place. It is
-- SECURITY INVOKER and not client-callable: its callers are SECURITY DEFINER
-- and already hold the bucket's row lock. It is not a lock and not a boundary.

create or replace function public.wallet_spendable_cents(p_family_id uuid, p_bucket_id uuid)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)::bigint
    from public.wallet_transactions
   where family_id = p_family_id
     and bucket_id = p_bucket_id
     and status in ('completed', 'processing');
$$;

comment on function public.wallet_spendable_cents(uuid, uuid) is
  'Spendable cents in one wallet bucket: completed rows plus live card holds (processing), the rule 0155 and 0342 use. Call it only while holding the bucket row lock (0483).';

revoke all on function public.wallet_spendable_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wallet_spendable_cents(uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.wallet_transfer(p_family_id uuid, p_from_child_wallet_id uuid, p_to_child_wallet_id uuid, p_amount bigint, p_note text DEFAULT NULL::text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_wallet_count integer;
  v_from_bucket uuid;
  v_available bigint;
  v_debit_id uuid;
  v_credit jsonb;
  v_note text := left(coalesce(nullif(trim(p_note), ''), 'Transfer'), 500);
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_from_child_wallet_id = p_to_child_wallet_id or p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select count(*) into v_wallet_count
    from public.child_wallets
   where family_id = p_family_id
     and is_active
     and id in (p_from_child_wallet_id, p_to_child_wallet_id);
  if v_wallet_count <> 2 then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;
  perform id from public.child_wallets
   where family_id = p_family_id and is_active and id in (p_from_child_wallet_id, p_to_child_wallet_id)
   order by id for update;

  select id into v_from_bucket
    from public.wallet_buckets
   where family_id = p_family_id and child_wallet_id = p_from_child_wallet_id and kind = 'spend'
   for update;
  if v_from_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing');
  end if;

  -- Under the bucket lock above, and counting live card holds (0483):
  -- the same balance wallet_reserve_card_auth and wallet_debit_spend_bucket see.
  v_available := public.wallet_spendable_cents(p_family_id, v_from_bucket);
  if p_amount > v_available then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by, metadata)
  values
    (p_family_id, p_from_child_wallet_id, v_from_bucket, 'transfer', 'completed', 'debit', p_amount,
     'Sent: ' || v_note, 'child_wallets', p_to_child_wallet_id, p_actor_id, p_actor_id,
     jsonb_build_object('note', v_note))
  returning id into v_debit_id;

  v_credit := public.wallet_credit_child_ledger(
    p_family_id, p_to_child_wallet_id, p_amount, 'transfer', 'Received: ' || v_note,
    p_actor_id, 'child_wallets', p_from_child_wallet_id
  );
  if coalesce((v_credit->>'ok')::boolean, false) is not true then
    raise exception 'wallet transfer credit failed: %', coalesce(v_credit->>'reason', 'unknown');
  end if;

  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail, metadata)
  values
    (p_family_id, p_actor_id, 'wallet_transfer', 'wallet_transactions', v_debit_id,
     left('Transferred ' || p_amount || ' cents', 500), jsonb_build_object('to_child_wallet_id', p_to_child_wallet_id));

  return jsonb_build_object('ok', true, 'debit_transaction_id', v_debit_id,
    'credit_transaction_id', v_credit->>'transaction_id');
end;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_decide_spend(p_family_id uuid, p_approval_id uuid, p_decision text, p_note text DEFAULT NULL::text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_approval public.parent_approvals%rowtype;
  v_txn public.wallet_transactions%rowtype;
  v_available bigint;
  v_bucket uuid;
begin
  if auth.uid() is null or p_actor_id is distinct from auth.uid() or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'invalid_decision'); end if;
  select * into v_approval from public.parent_approvals
   where id = p_approval_id and family_id = p_family_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_approval.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_processed'); end if;
  if v_approval.kind <> 'card_spend' or v_approval.ref_type <> 'wallet_transactions' or v_approval.ref_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_approval');
  end if;
  select * into v_txn from public.wallet_transactions where id = v_approval.ref_id and family_id = p_family_id for update;
  if not found or v_txn.status <> 'requires_parent_approval' then return jsonb_build_object('ok', false, 'reason', 'transaction_unavailable'); end if;

  if p_decision = 'approved' then
    select id into v_bucket from public.wallet_buckets
     where id = v_txn.bucket_id and family_id = p_family_id and child_wallet_id = v_txn.child_wallet_id and kind = 'spend' for update;
    if v_bucket is null then return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing'); end if;
    -- Under the bucket lock, counting live card holds (0483). The
    -- request being decided is 'requires_parent_approval', so it is not in the
    -- sum it is checked against.
    v_available := public.wallet_spendable_cents(p_family_id, v_bucket);
    if v_txn.amount_cents > v_available then return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_available); end if;
    update public.wallet_transactions set status = 'completed', approved_by = p_actor_id where id = v_txn.id;
  else
    update public.wallet_transactions set status = 'cancelled' where id = v_txn.id;
  end if;

  update public.parent_approvals
     set status = p_decision::public.approval_status, decided_by = p_actor_id,
         decided_at = now(), note = left(nullif(trim(coalesce(p_note, '')), ''), 1000)
   where id = v_approval.id;
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values (p_family_id, p_actor_id, 'spend_' || p_decision, 'wallet_transactions', v_txn.id,
    'Spend request ' || p_decision);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'transaction_id', v_txn.id);
end;
$function$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. An order records both families
-- ════════════════════════════════════════════════════════════════════════════
--
-- Checked first: is there a column to reuse? marketplace_orders has family_id
-- (the seller's) and buyer_member, and nothing else. marketplace_negotiations
-- already stores both families (family_id, buyer_family_id) and points at the
-- order it created (order_id), so the backfill takes that first, then the buyer
-- member's own family, then the listing's highest bidder for auction orders
-- whose buyer member has since gone. A row none of these resolve stays NULL and
-- is visible to the seller's family only, as it is today.

alter table public.marketplace_orders
  add column if not exists buyer_family_id uuid references public.families(id) on delete set null;

comment on column public.marketplace_orders.buyer_family_id is
  'The buying family. family_id is the SELLER''s family; for an auction, Buy-It-Now or negotiated order the buyer is always from another family (0483).';

create index if not exists idx_marketplace_orders_buyer_family
  on public.marketplace_orders(buyer_family_id, status, created_at desc)
  where buyer_family_id is not null;

update public.marketplace_orders o
   set buyer_family_id = coalesce(
         (select n.buyer_family_id from public.marketplace_negotiations n
           where n.order_id = o.id order by n.updated_at desc limit 1),
         (select fm.family_id from public.family_members fm where fm.id = o.buyer_member),
         (select l.highest_bidder_family_id from public.marketplace_listings l
           where l.id = o.listing_id and o.notes = 'Won at auction'))
 where o.buyer_family_id is null;

-- Every order is inserted by a SECURITY DEFINER function (0359 dropped the
-- client INSERT policy). The three cross-family paths set the column
-- explicitly below. This default covers the in-family ones (0154 offer accept,
-- 0315 status change) without redefining them: the buyer's own family.
create or replace function public.marketplace_orders_buyer_family_default()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.buyer_family_id is null and new.buyer_member is not null then
    select family_id into new.buyer_family_id
      from public.family_members where id = new.buyer_member;
  end if;
  return new;
end $$;
revoke all on function public.marketplace_orders_buyer_family_default() from public, anon, authenticated;

drop trigger if exists trg_marketplace_orders_buyer_family_default on public.marketplace_orders;
create trigger trg_marketplace_orders_buyer_family_default
  before insert on public.marketplace_orders
  for each row execute function public.marketplace_orders_buyer_family_default();

-- Who may read the order is decided by this column, so it is as fixed as the
-- parties (0409/0410). Same trigger, one more column.
drop trigger if exists trg_marketplace_orders_parties on public.marketplace_orders;
create trigger trg_marketplace_orders_parties
  before update on public.marketplace_orders
  for each row execute function public.columns_are_immutable('family_id', 'listing_id', 'buyer_member', 'seller_member', 'buyer_family_id');

-- A party is the buyer or the seller, each read in their OWN family. 0372 read
-- both against family_id (the seller's), so a buyer from another family was
-- never a party.
create or replace function public.is_marketplace_order_party(p_order_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.marketplace_orders o
     where o.id = p_order_id
       and (public.marketplace_member_id(o.family_id) in (o.buyer_member, o.seller_member)
            or (o.buyer_family_id is not null
                and public.marketplace_member_id(o.buyer_family_id) = o.buyer_member))
  );
$$;
revoke all on function public.is_marketplace_order_party(uuid) from public, anon;
grant execute on function public.is_marketplace_order_party(uuid) to authenticated, service_role;

-- Reads: the seller's family as before, and now the buyer's family, the same
-- shape as marketplace_negotiations (mkt_neg_select) and marketplace_bids.
drop policy if exists marketplace_orders_select on public.marketplace_orders;
create policy marketplace_orders_select on public.marketplace_orders for select to authenticated
  using (public.is_family_member(family_id) or public.is_family_member(buyer_family_id));

-- Updates: the two parties, each in their own family (was: both read against
-- family_id). 0433's terms trigger and the parties trigger above still pin
-- what an update may change.
drop policy if exists marketplace_orders_update on public.marketplace_orders;
create policy marketplace_orders_update on public.marketplace_orders for update to authenticated
  using ((public.is_family_member(family_id) or public.is_family_member(buyer_family_id))
         and public.is_marketplace_order_party(id))
  with check ((public.is_family_member(family_id) or public.is_family_member(buyer_family_id))
              and public.is_marketplace_order_party(id));

-- Handoffs: the row carries the ORDER's family_id (the app writes
-- order.family_id). Writes need a party. They no longer also need membership
-- of family_id, which a cross-family buyer never has. reference_shares_family
-- (0311) keeps family_id equal to the order's, so a party cannot file the row
-- under a third family.
do $$
declare p record;
begin
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'marketplace_handoffs' and permissive = 'PERMISSIVE' loop
    execute format('drop policy %I on public.marketplace_handoffs', p.policyname);
  end loop;
end $$;
-- Section 3: confirm_code is in this row, so the whole row is the parties'.
create policy mkt_handoff_select on public.marketplace_handoffs for select to authenticated
  using (public.is_marketplace_order_party(order_id));
create policy mkt_handoff_insert on public.marketplace_handoffs for insert to authenticated
  with check (public.is_marketplace_order_party(order_id));
create policy mkt_handoff_update on public.marketplace_handoffs for update to authenticated
  using (public.is_marketplace_order_party(order_id))
  with check (public.is_marketplace_order_party(order_id));
create policy mkt_handoff_delete on public.marketplace_handoffs for delete to authenticated
  using (public.is_marketplace_order_party(order_id));

drop trigger if exists trg_marketplace_handoffs_order_id_family on public.marketplace_handoffs;
create trigger trg_marketplace_handoffs_order_id_family
  before insert or update of order_id, family_id on public.marketplace_handoffs
  for each row execute function public.reference_shares_family('order_id', 'marketplace_orders');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Completing a hand-off is the two parties' act
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.marketplace_complete_handoff(p_order_id uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order record;
  v_handoff record;
  v_code text;
  v_expected text;
  v_seller_side uuid;
  v_buyer_side uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if p_order_id is null or length(coalesce(p_code, '')) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select id, family_id, buyer_family_id, buyer_member, seller_member, status
    into v_order
    from public.marketplace_orders
   where id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;
  -- The caller must BE the buyer or the seller, each in their own family
  -- (0483). 0199 asked only for membership of family_id, so any
  -- sibling who could read the code closed someone else's pickup, and a
  -- buyer from another family could never close their own.
  v_seller_side := public.marketplace_member_id(v_order.family_id);
  v_buyer_side  := public.marketplace_member_id(coalesce(v_order.buyer_family_id, v_order.family_id));
  if not ((v_seller_side is not null and v_seller_side in (v_order.buyer_member, v_order.seller_member))
          or (v_buyer_side is not null and v_buyer_side = v_order.buyer_member)) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_order.status not in ('confirmed', 'active', 'returned') then
    return jsonb_build_object('ok', false, 'reason', 'order_not_open');
  end if;

  select id, status, confirm_code
    into v_handoff
    from public.marketplace_handoffs
   where order_id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'handoff_not_found');
  end if;
  if v_handoff.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'handoff_not_ready');
  end if;

  v_code := regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  v_expected := regexp_replace(upper(coalesce(v_handoff.confirm_code, '')), '[^A-Z0-9]', '', 'g');
  if length(v_code) = 0 or v_code <> v_expected then
    return jsonb_build_object('ok', false, 'reason', 'code_mismatch');
  end if;

  update public.marketplace_handoffs
     set status = 'completed', completed_at = now()
   where id = v_handoff.id;

  update public.marketplace_orders
     set status = 'completed'
   where id = v_order.id
     and status in ('confirmed', 'active', 'returned');
  if not found then
    raise exception 'Marketplace order changed while completing handoff';
  end if;

  return jsonb_build_object('ok', true, 'status', 'completed');
end;
$function$;

revoke all on function public.marketplace_complete_handoff(uuid, text) from public, anon;
grant execute on function public.marketplace_complete_handoff(uuid, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. An investment order is placed on your own wallet, or by a manager
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.is_own_child_wallet(p_child_wallet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.child_wallets w
     where w.id = p_child_wallet_id
       and public.is_self_member(w.member_id)
  );
$$;
comment on function public.is_own_child_wallet(uuid) is
  'True when the child wallet belongs to the calling member (is_self_member on its member_id). Names the caller, so it is not an oracle (0483).';
revoke all on function public.is_own_child_wallet(uuid) from public, anon;
grant execute on function public.is_own_child_wallet(uuid) to authenticated, service_role;

drop policy if exists invest_orders_own_wallet_or_manager on public.invest_orders;
create policy invest_orders_own_wallet_or_manager on public.invest_orders
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id) or public.is_own_child_wallet(child_wallet_id));

-- 0311's wiring: the wallet must be in the order's own family.
drop trigger if exists trg_invest_orders_child_wallet_id_family on public.invest_orders;
create trigger trg_invest_orders_child_wallet_id_family
  before insert or update of child_wallet_id, family_id on public.invest_orders
  for each row execute function public.reference_shares_family('child_wallet_id', 'child_wallets');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Proxy bidding: a leader is not raised against itself; the reserve counts
--    the leader's max
-- ════════════════════════════════════════════════════════════════════════════
--
-- The body is 0183's as it stands after 0461, with three changes, each marked:
--   (a) the household that already leads raises only the hidden max;
--   (b) any branch that leaves a leader whose max covers the reserve shows at
--       least the reserve;
--   (c) nothing else: increments, anti-snipe and the losing-challenger branch
--       are unchanged.

CREATE OR REPLACE FUNCTION public.marketplace_place_bid_unchecked(p_listing_id uuid, p_bidder_member_id uuid, p_bidder_family_id uuid, p_max_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing   record;
  v_now       timestamptz := now();
  v_increment bigint;
  v_min_bid   bigint;
  v_new_visible bigint;
  v_extended  boolean := false;
begin
  -- Lock the listing so two bids can't race on the same current price.
  select * into v_listing from public.marketplace_listings
    where id = p_listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.sale_format <> 'auction' then return jsonb_build_object('ok', false, 'reason', 'not_auction'); end if;
  if v_listing.status <> 'available' then return jsonb_build_object('ok', false, 'reason', 'not_available'); end if;
  if v_listing.auction_ends_at is null or v_now >= v_listing.auction_ends_at then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;
  if v_listing.auction_starts_at is not null and v_now < v_listing.auction_starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  -- Can't bid on your own listing.
  if v_listing.family_id = p_bidder_family_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;

  -- (a) The household already in front (0483). Any higher max used
  -- to fall into the "new leader" branch, which priced the leader one
  -- increment over their OWN previous max and marked their own bid outbid.
  -- With no competitor, nothing moves the visible price: only the hidden max
  -- rises (on the listing and on their standing bid), unless (b) the raise
  -- newly covers the reserve. bid_count, the end time and the leader member
  -- are unchanged.
  if v_listing.bid_count > 0 and v_listing.highest_bidder_family_id = p_bidder_family_id then
    if p_max_cents <= v_listing.highest_max_cents then
      return jsonb_build_object('ok', false, 'reason', 'already_leading',
        'leading', true, 'current_cents', v_listing.current_bid_cents);
    end if;
    v_new_visible := v_listing.current_bid_cents;
    if v_listing.reserve_cents is not null and p_max_cents >= v_listing.reserve_cents
       and v_new_visible < v_listing.reserve_cents then
      v_new_visible := v_listing.reserve_cents;
    end if;
    update public.marketplace_bids
       set max_cents = p_max_cents, amount_cents = v_new_visible
     where listing_id = p_listing_id and status = 'active'
       and bidder_family_id = p_bidder_family_id;
    update public.marketplace_listings
       set highest_max_cents = p_max_cents, current_bid_cents = v_new_visible, updated_at = v_now
     where id = p_listing_id;
    return jsonb_build_object('ok', true, 'leading', true, 'raised_max', true,
      'current_cents', v_new_visible, 'extended', false);
  end if;

  -- Tiered minimum increment (eBay-like), based on current price.
  v_increment := case
    when v_listing.current_bid_cents < 100 then 5
    when v_listing.current_bid_cents < 500 then 25
    when v_listing.current_bid_cents < 2500 then 50
    when v_listing.current_bid_cents < 10000 then 100
    when v_listing.current_bid_cents < 25000 then 250
    when v_listing.current_bid_cents < 100000 then 500
    else 1000 end;

  -- Minimum acceptable max: at/above starting bid on the first bid, otherwise
  -- one increment over the current price.
  if v_listing.bid_count = 0 then
    v_min_bid := greatest(v_listing.starting_bid_cents, 1);
  else
    v_min_bid := v_listing.current_bid_cents + v_increment;
  end if;
  if p_max_cents < v_min_bid then
    return jsonb_build_object('ok', false, 'reason', 'too_low', 'min_cents', v_min_bid);
  end if;

  -- Proxy resolution.
  if v_listing.bid_count = 0 then
    -- First bid: visible price = starting bid.
    v_new_visible := greatest(v_listing.starting_bid_cents, v_increment);
    if v_new_visible > p_max_cents then v_new_visible := p_max_cents; end if;
  elsif p_max_cents > v_listing.highest_max_cents then
    -- New leader: reveal just enough to beat the previous leader's max.
    v_new_visible := least(p_max_cents, v_listing.highest_max_cents + v_increment);
    -- Mark the old leader outbid.
    update public.marketplace_bids set status = 'outbid'
      where listing_id = p_listing_id and status = 'active';
  else
    -- Bid doesn't beat the standing proxy: the leader auto-covers it. The
    -- visible price rises to one increment over this challenger (capped by the
    -- leader's max), the leader stays in front, and we record the loss.
    v_new_visible := least(v_listing.highest_max_cents, p_max_cents + v_increment);
    -- (b) The standing leader's max covers the reserve: show at least it.
    if v_listing.reserve_cents is not null and v_listing.highest_max_cents >= v_listing.reserve_cents
       and v_new_visible < v_listing.reserve_cents then
      v_new_visible := v_listing.reserve_cents;
    end if;
    insert into public.marketplace_bids
      (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents, status)
      values (p_listing_id, v_listing.family_id, p_bidder_member_id, p_bidder_family_id, p_max_cents, p_max_cents, 'outbid');
    update public.marketplace_listings
      set current_bid_cents = v_new_visible, bid_count = bid_count + 1, updated_at = v_now
      where id = p_listing_id;
    return jsonb_build_object('ok', true, 'leading', false, 'current_cents', v_new_visible);
  end if;

  -- (b) The new leader's max covers the reserve: show at least the reserve
  -- (never more than their max, since p_max_cents >= reserve here).
  if v_listing.reserve_cents is not null and p_max_cents >= v_listing.reserve_cents
     and v_new_visible < v_listing.reserve_cents then
    v_new_visible := v_listing.reserve_cents;
  end if;

  -- Record the winning (leading) bid + promote the bidder to highest.
  insert into public.marketplace_bids
    (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents, status)
    values (p_listing_id, v_listing.family_id, p_bidder_member_id, p_bidder_family_id, v_new_visible, p_max_cents, 'active');

  -- Anti-snipe: a bid inside the window pushes the end out.
  if v_listing.auction_ends_at - v_now < make_interval(mins => v_listing.anti_snipe_minutes) then
    v_extended := true;
  end if;

  update public.marketplace_listings set
    current_bid_cents = v_new_visible,
    bid_count = bid_count + 1,
    highest_bidder_member_id = p_bidder_member_id,
    highest_bidder_family_id = p_bidder_family_id,
    highest_max_cents = p_max_cents,
    auction_ends_at = case when v_extended
      then v_now + make_interval(mins => v_listing.anti_snipe_minutes) else auction_ends_at end,
    updated_at = v_now
  where id = p_listing_id;

  return jsonb_build_object('ok', true, 'leading', true,
    'current_cents', v_new_visible, 'extended', v_extended);
end $function$;

-- 0461/0456 left this service-only; keep it so after the replace.
revoke all on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) to service_role;

-- (c) Close: sold when the leader's MAX meets the reserve, settled at
-- greatest(visible price, reserve). That figure is never above the leader's
-- max, since highest_max_cents >= both. It also settles auctions whose bids
-- predate (b). The order records the winner's family (section 2).
CREATE OR REPLACE FUNCTION public.marketplace_close_auction(p_listing_id uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing record;
  v_now timestamptz := coalesce(p_now, now());
  v_sold boolean;
  v_amount bigint;
  v_order_id uuid;
begin
  -- Inside a SECURITY DEFINER function current_user is the OWNER, never the
  -- caller; the caller's role is in the request's JWT claims (0457).
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_listing
  from public.marketplace_listings
  where id = p_listing_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_listing.sale_format <> 'auction'
    or v_listing.status <> 'available'
    or v_listing.auction_ends_at is null
    or v_listing.auction_ends_at > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_due');
  end if;

  v_sold := v_listing.bid_count > 0
    and v_listing.highest_max_cents >= coalesce(v_listing.reserve_cents, 0)
    and v_listing.highest_bidder_member_id is not null
    and v_listing.highest_bidder_family_id is not null;
  v_amount := greatest(v_listing.current_bid_cents, coalesce(v_listing.reserve_cents, 0));

  update public.marketplace_listings
  set status = case when v_sold then 'claimed' else 'withdrawn' end,
      current_bid_cents = case when v_sold then v_amount else current_bid_cents end,
      auction_closed_at = v_now,
      claimed_by = case when v_sold then v_listing.highest_bidder_member_id else null end,
      claimed_at = case when v_sold then v_now else null end,
      updated_at = v_now
  where id = v_listing.id and status = 'available';

  if v_sold then
    insert into public.marketplace_orders
      (family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status,
       amount_cents, notes)
    values
      (v_listing.family_id, v_listing.highest_bidder_family_id, v_listing.id,
       v_listing.highest_bidder_member_id, v_listing.member_id, 'buy', 'confirmed', v_amount,
       'Won at auction')
    returning id into v_order_id;

    update public.marketplace_bids
    set status = 'won'
    where listing_id = v_listing.id
      and bidder_member_id = v_listing.highest_bidder_member_id
      and status = 'active';

    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  else
    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'closed',
    'sold', v_sold,
    'had_bids', v_listing.bid_count > 0,
    'listing_id', v_listing.id,
    'title', v_listing.title,
    'seller_family_id', v_listing.family_id,
    'winner_family_id', case when v_sold then v_listing.highest_bidder_family_id else null end,
    'winner_member_id', case when v_sold then v_listing.highest_bidder_member_id else null end,
    'current_bid_cents', case when v_sold then v_amount else v_listing.current_bid_cents end,
    'order_id', v_order_id
  );
end $function$;

revoke all on function public.marketplace_close_auction(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.marketplace_close_auction(uuid, timestamptz) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 6 + 7. Bid, Buy-It-Now and negotiation: a manager acts, and Buy-It-Now
--        closes at the first bid
-- ════════════════════════════════════════════════════════════════════════════
--
-- 'manager_only' is a new reason; the app actions already refuse first with
-- actions.onlyAParentGuardianCan16, and should map this reason to it too.
--
-- Buy-It-Now rule, chosen: refuse once bid_count > 0, not "once a bid exceeds
-- the buy-now price". Comparing current_bid_cents with buy_now_cents is unsafe
-- because the leader's hidden max can be above BIN while the visible price is
-- below it, and the BIN buyer would undercut a standing bidder anyway. It is
-- also the rule the app already applies (buyNowClosedByBids), and the usual
-- marketplace convention (BIN goes away at the first bid).

CREATE OR REPLACE FUNCTION public.marketplace_place_bid(p_listing_id uuid, p_bidder_member_id uuid, p_bidder_family_id uuid, p_max_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member_family uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select family_id into v_member_family
  from public.family_members
  where id = p_bidder_member_id and user_id = auth.uid() and is_active;

  if v_member_family is null or v_member_family is distinct from p_bidder_family_id then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  -- A bid commits the household to pay, and meet, another family's adult: a
  -- parent or adult makes it (0483; isManager in the app).
  if not public.can_manage_family(p_bidder_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'manager_only');
  end if;
  if p_max_cents is null or p_max_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  -- The listing must be one this family can see (0462).
  if not public.marketplace_listing_visible_to(p_listing_id, p_bidder_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return public.marketplace_place_bid_unchecked(
    p_listing_id, p_bidder_member_id, p_bidder_family_id, p_max_cents
  );
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_buy_now(p_listing_id uuid, p_buyer_member_id uuid, p_buyer_family_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing record;
  v_member_family uuid;
  v_order_id uuid;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  select family_id into v_member_family
  from public.family_members
  where id = p_buyer_member_id and user_id = auth.uid() and is_active;
  if v_member_family is null or v_member_family is distinct from p_buyer_family_id then
    return jsonb_build_object('ok', false, 'reason', 'unauthorized');
  end if;
  -- Buying commits the household to pay and meet another family's adult.
  if not public.can_manage_family(p_buyer_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'manager_only');
  end if;
  -- The listing must be one this family can see (0462).
  if not public.marketplace_listing_visible_to(p_listing_id, p_buyer_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select id, family_id, member_id, buy_now_cents, status, sale_format,
         auction_starts_at, auction_ends_at, bid_count
  into v_listing
  from public.marketplace_listings
  where id = p_listing_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.sale_format <> 'auction' or v_listing.buy_now_cents is null
    or v_listing.buy_now_cents <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;
  if v_listing.status <> 'available' then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;
  if v_listing.family_id = p_buyer_family_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;
  if v_listing.auction_ends_at is null or v_now >= v_listing.auction_ends_at then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;
  if v_listing.auction_starts_at is not null and v_now < v_listing.auction_starts_at then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  -- Buy-It-Now closes at the first bid (0483). Checked under the
  -- listing lock, so it cannot race a bid the way the app's pre-read can.
  if v_listing.bid_count > 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_available', 'detail', 'bids_placed');
  end if;

  update public.marketplace_listings
  set status = 'claimed', claimed_by = p_buyer_member_id,
      claimed_at = v_now, auction_closed_at = v_now, updated_at = v_now
  where id = p_listing_id and status = 'available';

  update public.marketplace_bids
  set status = 'lost'
  where listing_id = p_listing_id and status in ('active', 'outbid');

  insert into public.marketplace_orders
    (family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status,
     amount_cents, notes, created_by)
  values
    (v_listing.family_id, p_buyer_family_id, v_listing.id, p_buyer_member_id, v_listing.member_id,
     'buy', 'confirmed', v_listing.buy_now_cents, 'Buy-It-Now', auth.uid())
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_negotiation_offer(p_listing uuid, p_buyer_member uuid, p_buyer_family uuid, p_amount bigint, p_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_neg     public.marketplace_negotiations%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;

  -- The listing must be one this family can see (0462).
  if not public.marketplace_listing_visible_to(p_listing, p_buyer_family) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_listing from public.marketplace_listings where id = p_listing for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_listing.kind <> 'sell' then return jsonb_build_object('ok', false, 'reason', 'not_negotiable'); end if;
  if v_listing.status not in ('available','pending') then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;

  -- Caller must be the acting member of the buyer family they claim.
  v_caller := public.marketplace_member_id(p_buyer_family);
  if v_caller is null or v_caller is distinct from p_buyer_member then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;
  -- Every negotiation is between two families (0187's
  -- marketplace_negotiations_distinct_families), and the seller's acceptance
  -- of an offer makes a confirmed order. A parent or adult makes the offer or
  -- the counter (0483).
  if not public.can_manage_family(p_buyer_family) then
    return jsonb_build_object('ok', false, 'reason', 'manager_only');
  end if;
  if p_buyer_member = v_listing.member_id then
    return jsonb_build_object('ok', false, 'reason', 'own_listing');
  end if;
  -- A "make an offer" is a bid below the asking price; at/above, just buy it.
  if p_amount >= v_listing.price_cents and v_listing.price_cents > 0 then
    return jsonb_build_object('ok', false, 'reason', 'at_or_above_ask');
  end if;

  select * into v_neg from public.marketplace_negotiations
    where listing_id = p_listing and buyer_member_id = p_buyer_member and status = 'open'
    for update;

  if found then
    -- Existing thread → this is a buyer counter; only legal when it's the buyer's turn.
    if v_neg.last_actor <> 'seller' then
      return jsonb_build_object('ok', false, 'reason', 'not_your_turn', 'negotiation_id', v_neg.id);
    end if;
    update public.marketplace_negotiations
       set current_amount_cents = p_amount, last_actor = 'buyer',
           rounds_count = rounds_count + 1, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, p_listing, p_buyer_member, 'buyer', 'counter', p_amount, p_message);
    return jsonb_build_object('ok', true, 'negotiation_id', v_neg.id, 'amount_cents', p_amount, 'countered', true);
  end if;

  -- New thread.
  insert into public.marketplace_negotiations
    (family_id, listing_id, buyer_member_id, buyer_family_id, status, current_amount_cents, last_actor, rounds_count)
  values (v_listing.family_id, p_listing, p_buyer_member, p_buyer_family, 'open', p_amount, 'buyer', 1)
  returning * into v_neg;
  insert into public.marketplace_negotiation_rounds
    (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
  values (v_neg.id, p_listing, p_buyer_member, 'buyer', 'offer', p_amount, p_message);
  return jsonb_build_object('ok', true, 'negotiation_id', v_neg.id, 'amount_cents', p_amount, 'countered', false);
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_negotiation_respond(p_negotiation uuid, p_action text, p_amount bigint DEFAULT NULL::bigint, p_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_neg     public.marketplace_negotiations%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_seller_member uuid;
  v_buyer_caller  uuid;
  v_role    text;
  v_actor   uuid;
  v_order   uuid;
begin
  select * into v_neg from public.marketplace_negotiations where id = p_negotiation for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into v_listing from public.marketplace_listings where id = v_neg.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'listing_missing'); end if;
  if v_neg.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;

  -- Who is calling? Seller (listing owner) or the buyer on this thread.
  v_seller_member := public.marketplace_member_id(v_listing.family_id);
  v_buyer_caller  := public.marketplace_member_id(v_neg.buyer_family_id);
  if v_seller_member is not null and v_seller_member = v_listing.member_id then
    v_role := 'seller'; v_actor := v_seller_member;
  elsif v_buyer_caller is not null and v_buyer_caller = v_neg.buyer_member_id then
    v_role := 'buyer'; v_actor := v_buyer_caller;
  else
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  if p_action = 'withdraw' then
    if v_role <> 'buyer' then return jsonb_build_object('ok', false, 'reason', 'buyer_only'); end if;
    update public.marketplace_negotiations set status = 'withdrawn', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'withdraw', p_message);
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if p_action = 'decline' then
    if v_role <> 'seller' then return jsonb_build_object('ok', false, 'reason', 'seller_only'); end if;
    update public.marketplace_negotiations set status = 'declined', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'decline', p_message);
    return jsonb_build_object('ok', true, 'status', 'declined');
  end if;

  -- Countering or accepting moves the deal toward a confirmed order with
  -- another family, so a parent or adult of the acting side does it
  -- (0483). Withdrawing and declining only end a thread, and stay
  -- open to the party themselves.
  if p_action in ('counter', 'accept')
     and not public.can_manage_family(case v_role when 'seller' then v_listing.family_id
                                                  else v_neg.buyer_family_id end) then
    return jsonb_build_object('ok', false, 'reason', 'manager_only');
  end if;

  -- counter / accept require it to be this caller's turn.
  if (v_role = 'seller' and v_neg.last_actor <> 'buyer')
     or (v_role = 'buyer' and v_neg.last_actor <> 'seller') then
    return jsonb_build_object('ok', false, 'reason', 'not_your_turn');
  end if;

  if p_action = 'counter' then
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
    update public.marketplace_negotiations
       set current_amount_cents = p_amount, last_actor = v_role,
           rounds_count = rounds_count + 1, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'counter', p_amount, p_message);
    return jsonb_build_object('ok', true, 'status', 'open', 'amount_cents', p_amount);
  end if;

  if p_action = 'accept' then
    if v_listing.status not in ('available','pending') then
      return jsonb_build_object('ok', false, 'reason', 'not_available');
    end if;
    -- Claim the listing for this buyer + record the deal at the agreed price.
    update public.marketplace_listings
       set status = 'claimed', claimed_by = v_neg.buyer_member_id, claimed_at = now(), updated_at = now()
     where id = v_listing.id;

    insert into public.marketplace_orders
      (family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_by)
    values (v_listing.family_id, v_neg.buyer_family_id, v_listing.id, v_neg.buyer_member_id, v_listing.member_id,
            'buy', 'confirmed', v_neg.current_amount_cents, 'Agreed via Make an Offer', auth.uid())
    returning id into v_order;

    update public.marketplace_negotiations
       set status = 'agreed', agreed_amount_cents = v_neg.current_amount_cents,
           order_id = v_order, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'accept', v_neg.current_amount_cents, p_message);

    -- Close every competing thread + open offer on this now-claimed listing.
    update public.marketplace_negotiations set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open' and id <> v_neg.id;
    update public.marketplace_offers set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open';

    return jsonb_build_object('ok', true, 'status', 'agreed', 'order_id', v_order,
                              'amount_cents', v_neg.current_amount_cents);
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_action');
end $function$;

revoke all on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) from public, anon;
revoke all on function public.marketplace_buy_now(uuid, uuid, uuid) from public, anon;
revoke all on function public.marketplace_negotiation_offer(uuid, uuid, uuid, bigint, text) from public, anon;
revoke all on function public.marketplace_negotiation_respond(uuid, text, bigint, text) from public, anon;
grant execute on function public.marketplace_place_bid(uuid, uuid, uuid, bigint) to authenticated, service_role;
grant execute on function public.marketplace_buy_now(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.marketplace_negotiation_offer(uuid, uuid, uuid, bigint, text) to authenticated, service_role;
grant execute on function public.marketplace_negotiation_respond(uuid, text, bigint, text) to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Circles: managers join, create and share; owners remove, block and rotate
-- ════════════════════════════════════════════════════════════════════════════

-- 8a. Blocks. A removed family cannot rejoin with the code it already knows.
-- No client writes: only the RPCs below touch it. The owner family's managers
-- can read it, to show and lift blocks.
create table if not exists public.marketplace_circle_blocks (
  circle_id  uuid not null references public.marketplace_circles(id) on delete cascade,
  family_id  uuid not null references public.families(id) on delete cascade,
  blocked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (circle_id, family_id)
);
create index if not exists idx_marketplace_circle_blocks_family on public.marketplace_circle_blocks(family_id);
comment on table public.marketplace_circle_blocks is
  'Families a circle''s owner removed and barred from rejoining. Written only by marketplace_remove_circle_member / marketplace_unblock_circle_family (0483).';

alter table public.marketplace_circle_blocks enable row level security;
revoke all on public.marketplace_circle_blocks from anon, authenticated;
grant select on public.marketplace_circle_blocks to authenticated;
grant all on public.marketplace_circle_blocks to service_role;
drop policy if exists mkt_circle_blocks_owner_read on public.marketplace_circle_blocks;
create policy mkt_circle_blocks_owner_read on public.marketplace_circle_blocks for select to authenticated
  using (exists (select 1 from public.marketplace_circles c
                  where c.id = circle_id and public.can_manage_family(c.created_by_family)));

-- One owner test for the RPCs: p_family is the circle's owner AND the caller
-- manages p_family.
create or replace function public.marketplace_circle_owner_manager(p_circle uuid, p_family uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_family(p_family)
     and exists (select 1 from public.marketplace_circle_members m
                  where m.circle_id = p_circle and m.family_id = p_family and m.role = 'owner');
$$;
revoke all on function public.marketplace_circle_owner_manager(uuid, uuid) from public, anon;
grant execute on function public.marketplace_circle_owner_manager(uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marketplace_create_circle(p_family uuid, p_name text, p_emoji text DEFAULT '🤝'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_circle uuid;
  v_code   text;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;
  -- A circle opens the family's shared listings to other households: a parent
  -- or adult decides that (0483; isManager in the app).
  if not public.can_manage_family(p_family) then
    raise exception 'only a parent or adult can create a circle' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'circle needs a name';
  end if;

  select name into v_name from public.families where id = p_family;
  -- 8-char human-friendly code, retried on the rare collision (0314/0444).
  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(8), 'base64'),
                                     '0O1Iloi+/=', 'ABCDEJKFGH'), 1, 8));
    exit when not exists (select 1 from public.marketplace_circles c where c.join_code = v_code);
  end loop;

  insert into public.marketplace_circles (name, emoji, join_code, created_by_family, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_emoji), ''), '🤝'), v_code, p_family, auth.uid())
  returning id into v_circle;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'owner');

  return v_circle;
end $function$;

CREATE OR REPLACE FUNCTION public.marketplace_join_circle(p_family uuid, p_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_circle uuid;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;
  if not public.can_manage_family(p_family) then
    raise exception 'only a parent or adult can join a circle' using errcode = '42501';
  end if;

  -- Read a typed `0` as `O` and a typed `1` as `I` (0314).
  select id into v_circle from public.marketplace_circles
  where join_code = translate(upper(trim(p_code)), '01', 'OI');
  if v_circle is null then
    raise exception 'no circle with that code';
  end if;
  -- A family the owner removed does not come back with the old code. Same
  -- message as an unknown code: the block is the owner's, not an oracle.
  if exists (select 1 from public.marketplace_circle_blocks b
              where b.circle_id = v_circle and b.family_id = p_family) then
    raise exception 'no circle with that code';
  end if;

  select name into v_name from public.families where id = p_family;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'member')
  on conflict (circle_id, family_id) do nothing;

  return v_circle;
end $function$;

-- Remove a member family (and, by default, block it). Its shares into this
-- circle go with it, exactly as marketplace_leave_circle does for a family
-- leaving on its own.
create or replace function public.marketplace_remove_circle_member(
  p_family uuid, p_circle uuid, p_member_family uuid, p_block boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if not public.marketplace_circle_owner_manager(p_circle, p_family) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_member_family is null or p_member_family = p_family then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  delete from public.marketplace_listing_shares
   where circle_id = p_circle and family_id = p_member_family;
  delete from public.marketplace_circle_members
   where circle_id = p_circle and family_id = p_member_family and role <> 'owner';
  get diagnostics v_removed = row_count;

  if coalesce(p_block, true) then
    insert into public.marketplace_circle_blocks (circle_id, family_id, blocked_by)
    values (p_circle, p_member_family, auth.uid())
    on conflict (circle_id, family_id) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'removed', v_removed > 0, 'blocked', coalesce(p_block, true));
end $$;

create or replace function public.marketplace_unblock_circle_family(
  p_family uuid, p_circle uuid, p_blocked_family uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if not public.marketplace_circle_owner_manager(p_circle, p_family) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.marketplace_circle_blocks
   where circle_id = p_circle and family_id = p_blocked_family;
  return jsonb_build_object('ok', true);
end $$;

-- Rotate the join code. Families already in stay in; the old code stops
-- working at once.
create or replace function public.marketplace_rotate_circle_code(p_family uuid, p_circle uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text;
begin
  if auth.uid() is null or not public.marketplace_circle_owner_manager(p_circle, p_family) then
    raise exception 'only the circle owner''s parent or adult can rotate its code' using errcode = '42501';
  end if;
  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(8), 'base64'),
                                     '0O1Iloi+/=', 'ABCDEJKFGH'), 1, 8));
    exit when not exists (select 1 from public.marketplace_circles c where c.join_code = v_code);
  end loop;
  update public.marketplace_circles set join_code = v_code, updated_at = now() where id = p_circle;
  return v_code;
end $$;

revoke all on function public.marketplace_create_circle(uuid, text, text) from public, anon;
revoke all on function public.marketplace_join_circle(uuid, text) from public, anon;
revoke all on function public.marketplace_remove_circle_member(uuid, uuid, uuid, boolean) from public, anon;
revoke all on function public.marketplace_unblock_circle_family(uuid, uuid, uuid) from public, anon;
revoke all on function public.marketplace_rotate_circle_code(uuid, uuid) from public, anon;
grant execute on function public.marketplace_create_circle(uuid, text, text) to authenticated, service_role;
grant execute on function public.marketplace_join_circle(uuid, text) to authenticated, service_role;
grant execute on function public.marketplace_remove_circle_member(uuid, uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.marketplace_unblock_circle_family(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.marketplace_rotate_circle_code(uuid, uuid) to authenticated, service_role;

-- 8b. Sharing a listing into a circle is a manager's decision too (the app's
-- shareListingAction). Sharing is a table write, not an RPC, so the gate is a
-- RESTRICTIVE insert policy. Unsharing stays open: it only withdraws.
drop policy if exists mkt_listing_shares_manager_insert on public.marketplace_listing_shares;
create policy mkt_listing_shares_manager_insert on public.marketplace_listing_shares
  as restrictive for insert to authenticated
  with check (public.can_manage_family(family_id));

-- 8c. What a circle sees of a shared listing. marketplace_listings_circle_read
-- (0178) granted the WHOLE row across families: location ("Garage shelf"),
-- member_id, created_by, claimed_by and highest_bidder_member_id, which name
-- the specific member, perhaps a child. Row security cannot hide columns per
-- row, and a column revoke would also take them from the listing's own family.
-- So the cross-family read moves to a view that has only what a shopper needs
-- (the feed, the photo and description the seller wrote for buyers, and the
-- public auction state), plus the listing family's name. The base-table policy
-- goes.
--
-- The view runs as its owner (not security_invoker) and is a security barrier.
-- Its WHERE clause is the old policy: shared into a circle the caller's family
-- belongs to. Secrets stay out as in 0452 (reserve_cents, highest_max_cents).
--
-- DEPLOY: ship with the app reads moved to this view (see the header). The
-- in-circle actions themselves are unaffected, because place_bid, buy_now,
-- negotiation_offer and the question/save policies all go through
-- marketplace_listing_visible_to (0462), which does not depend on this policy.
create or replace view public.marketplace_circle_listings
with (security_barrier = true)
as
select l.id, l.family_id, f.name as family_name,
       l.title, l.description, l.kind, l.category, l.condition,
       l.price_cents, l.rent_period, l.photo_url, l.status,
       l.sale_format, l.starting_bid_cents, l.buy_now_cents, l.current_bid_cents,
       l.bid_count, l.has_reserve, l.reserve_met, l.highest_bidder_family_id,
       l.auction_starts_at, l.auction_ends_at, l.anti_snipe_minutes, l.auction_closed_at,
       l.created_at, l.updated_at
  from public.marketplace_listings l
  join public.families f on f.id = l.family_id
 where exists (select 1 from public.marketplace_listing_shares s
                where s.listing_id = l.id
                  and public.is_marketplace_circle_member(s.circle_id));

comment on view public.marketplace_circle_listings is
  'Listings shared into a circle the caller''s family belongs to, with only the shopper-facing columns. Replaces the whole-row marketplace_listings_circle_read policy (0483).';

revoke all on public.marketplace_circle_listings from public, anon, authenticated;
grant select on public.marketplace_circle_listings to authenticated, service_role;

drop policy if exists marketplace_listings_circle_read on public.marketplace_listings;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. A pending gift's text is the parents' to read first
-- ════════════════════════════════════════════════════════════════════════════
--
-- Every gift_payments write is already a manager's (0306 guards). The read was
-- the whole family's, so a child could read an outsider's giver_name and
-- message over the API before a parent saw it. Managers now read every row.
-- A child or teen reads only a gift a parent has already applied
-- ('completed') to their OWN wallet: the text has been reviewed by then, and
-- "who sent me this" is the child's to know. That matches the app at
-- 47919df02 (children see approved gifts only). It also keeps
-- money-decision-rows-check's "the child can see the gift credited to her".
-- This reverses the deliberate "reads stay open" recorded in
-- wallet-side-table-write-check.sql, so that probe and finalaudit.md change
-- with it (owner decision).
drop policy if exists gift_payments_select on public.gift_payments;
create policy gift_payments_select on public.gift_payments for select to authenticated
  using (public.can_manage_family(family_id)
         or (status = 'completed' and public.is_own_child_wallet(child_wallet_id)));

-- ════════════════════════════════════════════════════════════════════════════
-- self-check
-- ════════════════════════════════════════════════════════════════════════════
do $check$
declare
  v text;
begin
  -- 1: both callers use the helper, and neither still sums 'completed' alone.
  select string_agg(p.proname, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('wallet_decide_spend', 'wallet_transfer')
     and (p.prosrc !~ 'wallet_spendable_cents\(' or p.prosrc ~ $re$status = 'completed';$re$);
  if v is not null then
    raise exception '0483: these still miss live card holds: %', v;
  end if;
  if has_function_privilege('authenticated', 'public.wallet_spendable_cents(uuid,uuid)', 'execute') then
    raise exception '0483: wallet_spendable_cents is client-callable';
  end if;

  -- 2: the column exists, and every order path names it.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'marketplace_orders'
                    and column_name = 'buyer_family_id') then
    raise exception '0483: marketplace_orders.buyer_family_id is missing';
  end if;
  select string_agg(p.proname, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('marketplace_close_auction', 'marketplace_buy_now', 'marketplace_negotiation_respond')
     and p.prosrc !~ 'buyer_family_id';
  if v is not null then
    raise exception '0483: these create cross-family orders without the buyer''s family: %', v;
  end if;

  -- 3: completion names the party.
  if (select prosrc from pg_proc where oid = 'public.marketplace_complete_handoff(uuid,text)'::regprocedure)
       !~ 'v_order\.seller_member' then
    raise exception '0483: marketplace_complete_handoff does not check the party';
  end if;

  -- 7: every acting RPC gates on can_manage_family.
  select string_agg(p.proname, ', ') into v
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('marketplace_place_bid', 'marketplace_buy_now', 'marketplace_negotiation_offer',
                       'marketplace_negotiation_respond', 'marketplace_create_circle', 'marketplace_join_circle')
     and p.prosrc !~ 'can_manage_family\(';
  if v is not null then
    raise exception '0483: these act for a household without a manager check: %', v;
  end if;

  -- 0452 must still hold: the listings/bids secret columns are not selectable.
  if has_column_privilege('authenticated', 'public.marketplace_listings', 'highest_max_cents', 'SELECT')
     or has_column_privilege('authenticated', 'public.marketplace_listings', 'reserve_cents', 'SELECT') then
    raise exception '0483: a proxy-bid secret became selectable';
  end if;
end
$check$;
