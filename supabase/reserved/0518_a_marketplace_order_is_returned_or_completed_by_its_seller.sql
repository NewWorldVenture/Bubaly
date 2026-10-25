-- 0518 — A marketplace order is returned or completed by its seller.
-- Found by Support while finishing claude/marketplace-transactions-7q6vtf
-- (its a9ea4a5a2 says "enforcing it there needs a migration"); requested on
-- #771 in comment 6133974146.
--
-- lib/marketplace/order-lifecycle.ts makes `returned` and `completed` the
-- seller's steps (SELLER_ONLY_ORDER_STEPS; on a rent or a borrow, the lender's),
-- and setOrderStatusAction (app/(app)/marketplace/actions.ts) refuses either one
-- unless order.seller_member is the caller's own member. The database does not
-- agree: marketplace_orders_update (0483) admits either party, each in their
-- own family, and 0409/0433's triggers freeze the terms and the parties but not
-- `status`. So the buyer bypasses the action with one PostgREST PATCH, and so
-- does a buyer in the seller's own family (an in-family order). Measured on a
-- replay of every runnable migration, as the buyer under PostgREST's role:
--
--   active borrow   -> returned                                1 row
--   active sale     -> completed                               1 row
--   returned borrow -> completed                               1 row
--   returned_at := now() on an active borrow                   1 row
--   active borrow whose lender's member row is gone -> returned 1 row
--   in-family buyer: active sale -> completed                  1 row
--
-- A borrower marks an item returned while still holding it, which also ends
-- its overdue reminders (lib/marketplace/returns.ts reads `returned_at` or a
-- returned/completed status as returned, and needsOverdueAlert then never
-- fires), and a buyer completes a sale that was never handed over, which
-- opens reviews and counts as the seller's completed sale.
--
-- This adds a BEFORE UPDATE row guard on marketplace_orders. For a client's
-- own statement (current_user authenticated or anon, decided in a SECURITY
-- INVOKER trigger exactly as 0458 and 0482 do), a change of `status` to
-- `returned` or `completed`, or any change of `returned_at`, is refused (42501,
-- its own sentence) unless the caller is the order's seller_member: the
-- member public.marketplace_member_id(family_id) names (family_id is the
-- seller's family, 0483), the same seller test 0483's is_marketplace_order_party
-- makes, and the app's `order.seller_member === ctx.active.member.id`. It is
-- the seller member, not the seller's family: a buyer inside the seller's
-- family is still the buyer, and a non-party of either family is filtered by
-- the update policy before this runs.
--
-- Unchanged, each proven by the probe:
--   * every other step either party takes (confirm, start, cancel), and the
--     arrangements (notes, dates);
--   * marketplace_complete_handoff, the in-person hand-off code either party
--     may enter (0483 section 3): it is SECURITY DEFINER, so its UPDATE runs as
--     the function's owner and the guard lets it through. The code is the
--     proof of the exchange, and the app keeps that path for both sides;
--   * the service role (the return-reminder cron stamps two other columns),
--     migrations and seeds without a session, and FK cascades.
-- Not changed here, and left to the owner: the database still has no order
-- state machine (ORDER_FLOW lives in the action), so a party can still move an
-- order between the other statuses out of order; and the return-reminder
-- stamps (due_reminder_sent_at, overdue_notified_at) are still writable by
-- either party, though only the cron writes them.
--
-- HELD: 0518, the first number above the held 0517 (0515 is requested on #771
-- in comment 6109587749 and not released; it is not filled here), requested on
-- #771 in comment 6133974146 and not yet confirmed. It stays in
-- supabase/reserved/ until every number below it has landed. Proven by
-- docs/audit/reserved/a-marketplace-order-is-returned-or-completed-by-its-seller-check.sql
-- and .github/workflows/marketplace-order-finish-runtime.yml. Not applied to
-- production by an agent; recording it in docs/PENDING_PROD_MIGRATIONS.md is
-- the owner's.

do $$
begin
  if to_regclass('public.marketplace_orders') is null then
    raise exception '0518 needs public.marketplace_orders';
  end if;
  if to_regprocedure('public.marketplace_member_id(uuid)') is null then
    raise exception '0518 needs public.marketplace_member_id(uuid) (0154)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'marketplace_orders'
                    and column_name = 'returned_at') then
    raise exception '0518 needs marketplace_orders.returned_at (0192)';
  end if;
end
$$;

create or replace function public.marketplace_order_is_finished_by_its_seller()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only a client's own statement. The service role, a migration or seed with
  -- no session, an FK cascade and the database's own SECURITY DEFINER
  -- functions (marketplace_complete_handoff among them) run as another role.
  -- This must stay SECURITY INVOKER, or current_user is the owner and every
  -- caller is exempt (0334, 0482).
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.status is distinct from old.status and new.status in ('returned', 'completed'))
     or new.returned_at is distinct from old.returned_at then
    -- The seller member, in the seller's family (family_id). A null seller
    -- (the member row is gone) is nobody's to finish from a client.
    if new.seller_member is null
       or public.marketplace_member_id(new.family_id) is distinct from new.seller_member then
      raise exception 'Only the seller marks a marketplace order returned or completed'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

comment on function public.marketplace_order_is_finished_by_its_seller() is
  'Refuses (42501) a client (current_user authenticated/anon) changing marketplace_orders.status to returned or completed, or changing returned_at, unless the caller is the order''s seller_member (marketplace_member_id(family_id)), as setOrderStatusAction does (0518). The service role, session-less writers, FK cascades and SECURITY DEFINER functions such as marketplace_complete_handoff are unaffected.';

revoke all on function public.marketplace_order_is_finished_by_its_seller() from public, anon, authenticated;

drop trigger if exists trg_marketplace_orders_finished_by_its_seller on public.marketplace_orders;
create trigger trg_marketplace_orders_finished_by_its_seller
  before update on public.marketplace_orders
  for each row execute function public.marketplace_order_is_finished_by_its_seller();

do $$
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.marketplace_orders'::regclass
                    and t.tgname = 'trg_marketplace_orders_finished_by_its_seller'
                    and t.tgfoid = 'public.marketplace_order_is_finished_by_its_seller()'::regprocedure
                    and t.tgenabled <> 'D'
                    and (t.tgtype & 2) = 2       -- BEFORE
                    and (t.tgtype & 1) = 1       -- ROW
                    and (t.tgtype & 16) = 16) then -- UPDATE
    raise exception '0518: marketplace_orders does not carry the enabled BEFORE UPDATE row guard';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.marketplace_order_is_finished_by_its_seller()'::regprocedure
                    and not f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c = 'search_path=""')) then
    raise exception '0518: the guard must be SECURITY INVOKER (current_user is the owner otherwise, and every caller is exempt) with search_path pinned empty';
  end if;
end
$$;
