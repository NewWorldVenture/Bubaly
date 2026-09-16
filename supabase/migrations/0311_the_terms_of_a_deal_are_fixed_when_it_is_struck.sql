-- ============================================================================
-- 0311 — an UPDATE policy that guards the row it lets you touch, but not the
--        row you turn it into.
--
-- Raised by Claude-3 against `marketplace_orders_update`. Swept by SHAPE rather
-- than by name, which found a second one the report had missed:
--
--   select … from pg_policy
--    where polcmd = 'w' and polpermissive
--      and polqual is not null and polwithcheck is not null
--      and pg_get_expr(polwithcheck, polrelid) <> pg_get_expr(polqual, polrelid)
--
-- returns exactly two rows in the whole `public` schema, and they are a pair:
--
--   marketplace_orders_update
--     using      is_family_member(family_id)
--                and (buyer_member = marketplace_member_id(family_id)
--                     or seller_member = marketplace_member_id(family_id))
--     with check  is_family_member(family_id)
--
--   marketplace_offers_update
--     using      is_family_member(family_id)
--                and (member_id = marketplace_member_id(family_id)
--                     or exists (… the listing's owner …))
--     with check  is_family_member(family_id)
--
-- The USING clause is careful: only the two parties may advance the lifecycle.
-- The WITH CHECK drops the condition entirely, so the row you are allowed to
-- touch can be rewritten into a row you would never have been allowed to
-- touch — reassign `buyer_member`, re-price `amount_cents`, move an offer onto
-- another listing. Same asymmetry 0297 fixed on `invites_update`.
--
-- TWO rules, because the policy alone is not enough.
--
--   1. Make the WITH CHECK the USING, as 0297 did. That stops a non-party
--      writing the row into existence around themselves.
--
--   2. Fix the TERMS with a trigger, because rule 1 leaves a real hole: WITH
--      CHECK is a disjunction, so a seller who satisfies `seller_member = me`
--      in the new row still passes it while rewriting `buyer_member` to
--      somebody else. The trigger does not care which branch admitted the row.
--
-- Nothing in the product wants to write those columns after the fact, and this
-- was checked rather than assumed. Every UPDATE to either table, from every
-- path, sets `status` and `updated_at` and nothing else:
--
--   app/(app)/marketplace/actions.ts:147   update({ status })
--   marketplace_complete_handoff           set status = 'completed'
--   marketplace_accept_offer               set status = 'accepted' / 'declined'
--   marketplace_decline_offer              set status = 'declined'
--   marketplace_negotiation_respond        set status = 'declined'
--
-- plus the return-reminder cron, which stamps `due_reminder_sent_at` and
-- `overdue_notified_at` through the service client. Neither column is frozen
-- here, and the service role is let through regardless, in 0322's idiom.
--
-- Not changed: reads, inserts, and every other column. `status`, `notes`,
-- `starts_on`, `ends_on` and `message` stay editable — advancing a deal is the
-- feature. `kind` is frozen with the money, because the return-reminder cron
-- scopes itself `where kind in ('rent','borrow')`, so flipping it is a way to
-- walk away from a borrowed item without the overdue notice ever firing.
--
-- Observed while reading the live policy, and deliberately left alone: 0154
-- wrote `marketplace_member_id(family_id)` inside the offers subquery meaning
-- the OUTER row's column, and Postgres bound it to the inner `l.family_id`.
-- The binding is benign — an offer and its listing are in the same family, and
-- the listing's family is the more correct one for a listing-owner check — but
-- it is worth naming as read rather than as written.
-- ============================================================================

-- ── Rule 1: the check on the new row is the check on the old one ────────────
do $$
begin
  execute 'drop policy if exists marketplace_orders_update on public.marketplace_orders';
  execute 'create policy marketplace_orders_update on public.marketplace_orders for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  buyer_member = public.marketplace_member_id(family_id) '
       || '  or seller_member = public.marketplace_member_id(family_id))) '
       || 'with check (public.is_family_member(family_id) and ('
       || '  buyer_member = public.marketplace_member_id(family_id) '
       || '  or seller_member = public.marketplace_member_id(family_id)))';

  execute 'drop policy if exists marketplace_offers_update on public.marketplace_offers';
  execute 'create policy marketplace_offers_update on public.marketplace_offers for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  member_id = public.marketplace_member_id(family_id) '
       || '  or exists (select 1 from public.marketplace_listings l where l.id = listing_id '
       || '             and l.member_id = public.marketplace_member_id(l.family_id)))) '
       || 'with check (public.is_family_member(family_id) and ('
       || '  member_id = public.marketplace_member_id(family_id) '
       || '  or exists (select 1 from public.marketplace_listings l where l.id = listing_id '
       || '             and l.member_id = public.marketplace_member_id(l.family_id))))';
end $$;

-- ── Rule 2: the terms themselves ────────────────────────────────────────────
--
-- Column-wise, in the idiom main's 0305 uses for chore_assignments and 0322 for the
-- family's entitlement: name the columns that carry the deal and refuse an
-- untrusted writer touching them, leaving the rest of the row alone. The frozen
-- list travels as a trigger argument so both tables share one function and the
-- difference between them is legible at the CREATE TRIGGER.
create or replace function public.marketplace_deal_terms_are_fixed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  col text;
  before_row jsonb;
  after_row  jsonb;
begin
  -- The trusted server keeps its reach: the return-reminder cron writes through
  -- the service client, and a migration or seed runs with no session at all.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  before_row := to_jsonb(old);
  after_row  := to_jsonb(new);

  foreach col in array tg_argv[0]::text[] loop
    -- `is distinct from` on the jsonb, so NULL -> value and value -> NULL are
    -- both caught. `buyer_member` and `seller_member` are nullable, and NULL is
    -- exactly what you would write to shake a counterparty off a deal.
    if before_row -> col is distinct from after_row -> col then
      raise exception '% is a term of the deal and is fixed when it is struck (%)',
        col, tg_table_name
        using errcode = '42501';
    end if;
  end loop;

  return new;
end
$fn$;

revoke all on function public.marketplace_deal_terms_are_fixed() from public;

drop trigger if exists trg_marketplace_orders_terms_are_fixed on public.marketplace_orders;
create trigger trg_marketplace_orders_terms_are_fixed
  before update on public.marketplace_orders
  for each row execute function public.marketplace_deal_terms_are_fixed(
    '{family_id,listing_id,buyer_member,seller_member,kind,amount_cents,created_by,created_at}');

drop trigger if exists trg_marketplace_offers_terms_are_fixed on public.marketplace_offers;
create trigger trg_marketplace_offers_terms_are_fixed
  before update on public.marketplace_offers
  for each row execute function public.marketplace_deal_terms_are_fixed(
    '{family_id,listing_id,member_id,kind,amount_cents,created_by,created_at}');

-- ── The sweep, by shape ─────────────────────────────────────────────────────
-- Not "are those two fixed" — "is the class empty". A future policy that guards
-- the old row and waves the new one through fails here, at replay, named.
--
-- The property is "the WITH CHECK is not WEAKER than the USING", which is not
-- decidable from the expressions. The sound approximation is CONTAINMENT: the
-- WITH CHECK passes if it is the USING, or if it carries the USING inside it
-- (`is_family_member(family_id) and is_self_member(member_id)` against a USING
-- of `is_self_member(member_id)` is strictly stronger, and that is the common
-- and correct shape).
--
-- That leaves one genuine exception, and it is named rather than papered over,
-- because it is the shape worth protecting: a TRANSITION guard, where the new
-- row is meant to be judged by a different rule than the old one.
--
--   approval_requests_cancel_own
--     using      status = 'pending'   and <the requester, still active>
--     with check status = 'cancelled' and <the same requester>
--
-- The USING and the WITH CHECK disagree on purpose: you may take a pending
-- request of your own and make it cancelled, and you may do nothing else to it.
-- A containment rule cannot tell that from the marketplace bug, so it is listed
-- here with its reason. Add to this list only with the same kind of sentence.
do $$
declare
  transition_guards text[] := array['approval_requests_cancel_own'];
  stragglers text;
begin
  select string_agg(format('%s.%s', p.polrelid::regclass, p.polname), ', ')
    into stragglers
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polcmd in ('w', '*')
    and p.polpermissive
    and p.polqual is not null
    and p.polwithcheck is not null
    and not (p.polname = any (transition_guards))
    and position(pg_get_expr(p.polqual, p.polrelid)
                 in pg_get_expr(p.polwithcheck, p.polrelid)) = 0;

  if stragglers is not null then
    raise exception '0311: UPDATE policies guard the old row more tightly than the new one: %. Either carry the USING into the WITH CHECK, or add the policy to transition_guards here with a sentence saying why the new row is judged by a different rule.', stragglers;
  end if;
end $$;
