-- Behavioural proof for 0311, run as real `authenticated` sessions under RLS.
--
-- `marketplace_orders_update` and `marketplace_offers_update` each guarded the
-- row you were allowed to TOUCH — only the two parties, only the offerer or the
-- listing's owner — and then let you turn it into a row you would never have
-- been allowed to touch, because the WITH CHECK was `is_family_member(family_id)`
-- and nothing more.
--
-- Two of the cases below are the reason the policy fix alone was not enough.
-- WITH CHECK is a disjunction: a seller who still satisfies `seller_member = me`
-- in the NEW row passes it while rewriting `buyer_member` to somebody else, or
-- while re-pricing the deal. Only the trigger sees that, and the trigger does
-- not care which branch of the policy admitted the row.
--
-- Advancing a deal is the feature and is asserted throughout: status moves,
-- notes and dates stay editable, and the return-reminder cron keeps its stamps.
--
-- Which rule catches what, established by reverting each one separately rather
-- than assumed: denials 1-5 fire when the triggers are dropped and the WITH
-- CHECK is left symmetric, so the trigger is the only thing stopping them.
-- Denial 7b survives that and fires only when the WITH CHECK is reverted. Both
-- rules are load-bearing; neither is decoration.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam         uuid := 'ffff2222-0000-4000-8000-00000000000e';
  seller_uid  uuid := 'f2000000-0000-4000-8000-000000000001';
  buyer_uid   uuid := 'f2000000-0000-4000-8000-000000000002';
  other_uid   uuid := 'f2000000-0000-4000-8000-000000000003';
  seller_mid  uuid;
  buyer_mid   uuid;
  other_mid   uuid;
  listing     uuid;
  listing_b   uuid;
  ord         uuid;
  off         uuid;
  n           int;
  v_text      text;
  v_cents     bigint;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  -- Namespaced ids of its own, so a sibling probe's teardown cannot reach in.
  delete from public.marketplace_orders   where family_id = fam;
  delete from public.marketplace_offers   where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members       where user_id in (seller_uid, buyer_uid, other_uid);
  delete from public.families             where id = fam;

  insert into public.families (id, name) values (fam, 'Marketplace');
  insert into auth.users (id, email) values
    (seller_uid, 'ms@example.test'), (buyer_uid, 'mb@example.test'), (other_uid, 'mo@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, seller_uid, 'Seller', 'parent', true) returning id into seller_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, buyer_uid, 'Buyer', 'teen', true) returning id into buyer_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, other_uid, 'Bystander', 'teen', true) returning id into other_mid;

  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, created_by)
  values (fam, seller_mid, 'Bike', 'borrow', 0, seller_uid) returning id into listing;
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, created_by)
  values (fam, other_mid, 'Tent', 'sell', 500, other_uid) returning id into listing_b;

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, created_by)
  values (fam, listing, buyer_mid, seller_mid, 'borrow', 'requested', 2500, buyer_uid)
  returning id into ord;

  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, amount_cents, status, created_by)
  values (fam, listing_b, buyer_mid, 'offer', 400, 'open', buyer_uid)
  returning id into off;

  -- ══ POSITIVE CONTROLS FIRST ════════════════════════════════════════════
  -- If these stop working the fix has broken the product, and every denial
  -- below would be proving nothing but a table nobody can write.

  perform set_config('request.jwt.claim.sub', buyer_uid::text, true);
  set local role authenticated;

  update public.marketplace_orders set status = 'confirmed' where id = ord;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a buyer can no longer advance their own order (%)', n;
  end if;

  update public.marketplace_orders set notes = 'leave it by the shed', ends_on = current_date + 7
   where id = ord;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a buyer can no longer edit the arrangements on their own order (%)', n;
  end if;

  update public.marketplace_offers set status = 'withdrawn', message = 'changed my mind' where id = off;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'an offerer can no longer withdraw their own offer (%)', n;
  end if;
  update public.marketplace_offers set status = 'open' where id = off;

  reset role;
  perform set_config('request.jwt.claim.sub', seller_uid::text, true);
  set local role authenticated;

  update public.marketplace_orders set status = 'active' where id = ord;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a seller can no longer advance an order they are party to (%)', n;
  end if;

  -- ══ THE BOUNDARY ═══════════════════════════════════════════════════════

  -- 1. A seller rewriting the counterparty. This is the case the WITH CHECK
  --    alone does NOT catch: the new row still has `seller_member = me`, so the
  --    policy's disjunction is satisfied and only the trigger objects.
  begin
    update public.marketplace_orders set buyer_member = other_mid where id = ord;
    raise exception 'a seller reassigned the buyer on a live order';
  exception when insufficient_privilege then
    null;
  end;

  -- 2. A seller re-pricing a struck deal. Same shape, same reason.
  begin
    update public.marketplace_orders set amount_cents = 1 where id = ord;
    raise exception 'a seller re-priced a struck deal';
  exception when insufficient_privilege then
    null;
  end;

  -- 3. Flipping `kind` off 'borrow'. The return-reminder cron scopes itself
  --    `where kind in ('rent','borrow')`, so this is how you walk away with a
  --    borrowed bike and never see an overdue notice.
  begin
    update public.marketplace_orders set kind = 'donate' where id = ord;
    raise exception 'a borrow was quietly converted into a donation';
  exception when insufficient_privilege then
    null;
  end;

  -- 4. Moving the order to another family's… no: to another LISTING, which is
  --    how you attach a settled payment to an item you never handed over.
  begin
    update public.marketplace_orders set listing_id = listing_b where id = ord;
    raise exception 'an order was moved onto a different listing';
  exception when insufficient_privilege then
    null;
  end;

  -- 5. A bystander, party to nothing, writing the order at all. This one the
  --    USING already refused; it is asserted so the policy is not quietly lost.
  reset role;
  perform set_config('request.jwt.claim.sub', other_uid::text, true);
  set local role authenticated;

  update public.marketplace_orders set status = 'cancelled' where id = ord;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a member who is neither buyer nor seller wrote the order (%)', n;
  end if;

  -- 6. …and cannot write themselves INTO it either. Before 0311 the WITH CHECK
  --    was `is_family_member(family_id)`, so the row the USING refused could
  --    still be rewritten by anyone the USING happened to admit.
  select buyer_member into v_text from public.marketplace_orders where id = ord;
  if v_text is distinct from buyer_mid::text then
    raise exception 'the buyer on the order is no longer the buyer';
  end if;

  -- 7. Still as the bystander — who is not a bystander here: they own
  --    `listing_b`, which is the listing this offer was made ON. So they may
  --    decline it, and that is asserted. They may not re-price it, and they may
  --    not pull it onto somebody else's listing.
  --
  --    The second of those is the one denial below that the TRIGGER is not what
  --    stops: the offers policy's disjunction is evaluated against the NEW row's
  --    `listing_id`, so with the WITH CHECK weak, a listing owner could move an
  --    offer they do not own onto a listing they do. Proven by mutation — it is
  --    the only assertion here that survives dropping the triggers and fails
  --    when the WITH CHECK is reverted.
  begin
    update public.marketplace_offers set amount_cents = 10 where id = off;
    raise exception 'a listing owner re-priced an offer made to them';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.marketplace_offers set listing_id = listing where id = off;
    raise exception 'an offer was moved onto a different listing';
  exception when insufficient_privilege then
    null;
  end;
  update public.marketplace_offers set status = 'declined' where id = off;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a listing owner can no longer decline an offer on their listing (%)', n;
  end if;

  -- ══ THE TRUSTED SERVER IS NOT LOCKED OUT ═══════════════════════════════
  -- The return-reminder cron writes these two stamps through the service
  -- client. A guard that also stopped the cron would be the same bug renamed.
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  update public.marketplace_orders
     set overdue_notified_at = now(), due_reminder_sent_at = now()
   where id = ord;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the return-reminder cron can no longer stamp an order (%)', n;
  end if;

  -- And the trusted server can still correct a term when it genuinely must.
  update public.marketplace_orders set amount_cents = 2500 where id = ord;
  select amount_cents into v_cents from public.marketplace_orders where id = ord;
  if v_cents <> 2500 then
    raise exception 'the trusted server cannot correct an order (%)', v_cents;
  end if;

  raise notice '0311 marketplace deal terms: all assertions held';
end $$;

-- The class, not the two names: no permissive UPDATE policy in `public` may
-- guard the old row more tightly than the new one, bar the one transition guard
-- 0311 names and explains.
do $$
declare
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
    and p.polname <> 'approval_requests_cancel_own'
    and position(pg_get_expr(p.polqual, p.polrelid)
                 in pg_get_expr(p.polwithcheck, p.polrelid)) = 0;

  if stragglers is not null then
    raise exception 'an UPDATE policy guards the old row more tightly than the new one: %', stragglers;
  end if;
  raise notice '0311 asymmetric-WITH-CHECK sweep: clean';
end $$;
