-- ── 0309: an UPDATE policy checks the row you end with, not just the one you
--          started from ───────────────────────────────────────────────────────
--
-- 0154 closed the marketplace's object-level authorization gap and said so in
-- its header: no more forging a member id to inflate a trust score. It tied
-- every INSERT to the acting member and every UPDATE to the row owner — but it
-- wrote the ownership predicate in `using` only, leaving
-- `with check (is_family_member(family_id))`. So the ownership test governed
-- the row you started from and said nothing about the row you produced.
--
-- Measured before 0309, as the BUYER on a completed order:
--   NOTICE: orders: buyer rewrote seller_member on 1 row(s)
--   NOTICE: reputation read: C now shows 1 completed sale(s)
-- which is the number marketplace/item/[id]/page.tsx:87 and
-- marketplace/creators/[id]/page.tsx:58 display as a seller's track record.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/marketplace-ownership-update-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S6-08.
do $$
declare
  fam uuid := 'f0309000-0000-4000-8000-00000000fa01';
  ua  uuid := 'f0309000-0000-4000-8000-00000000c001';
  uc  uuid := 'f0309000-0000-4000-8000-00000000c003';
  ma uuid; mc uuid; lst uuid; ord uuid; off uuid;
  n int; refused boolean;
begin
  insert into public.families (id, name) values (fam, '0309 marketplace ownership') on conflict do nothing;
  insert into auth.users (id, email) values
    (ua, 'a0309@example.test'), (uc, 'c0309@example.test') on conflict do nothing;
  delete from public.marketplace_orders   where family_id = fam;
  delete from public.marketplace_offers   where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members       where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, ua, 'Seller A', 'parent', true) returning id into ma;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uc, 'Buyer C', 'parent', true) returning id into mc;

  insert into public.marketplace_listings (family_id, member_id, title, kind, category, price_cents, status)
    values (fam, ma, 'Bike', 'sell', 'sports', 5000, 'available') returning id into lst;
  -- A sold to C. A is the seller of record; C is nobody's seller.
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents)
    values (fam, lst, mc, ma, 'buy', 'completed', 5000) returning id into ord;
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status)
    values (fam, lst, mc, 'offer', 'open') returning id into off;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uc::text, true);
  if auth.uid() is distinct from uc then
    raise exception '0309: impersonation failed — auth.uid() is %, expected the buyer; this probe is not testing what it claims', auth.uid();
  end if;

  -- ── The forged sale ───────────────────────────────────────────────────────
  refused := false;
  begin
    update public.marketplace_orders set seller_member = mc where id = ord;
  -- Only the RLS refusal counts; `when others` would let a renamed column
  -- report the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0309: a BUYER made themselves the seller of record on their own completed order';
  end if;

  -- Belt and braces: the reputation figure those two pages render.
  select count(*) into n from public.marketplace_orders
   where family_id = fam and seller_member = mc and status = 'completed';
  if n <> 0 then
    raise exception '0309: the buyer shows % completed sale(s) they never made', n;
  end if;

  -- ── The spoofed member id, via update instead of insert ───────────────────
  refused := false;
  begin
    update public.marketplace_offers set member_id = ma where id = off;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0309: an offer was reassigned to a member who did not make it';
  end if;

  -- ── The marketplace must still BE a marketplace ───────────────────────────
  -- setOrderStatusAction (app/(app)/marketplace/actions.ts) updates `status`
  -- alone; a party must keep being able to advance their own order.
  update public.marketplace_orders set status = 'returned' where id = ord;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0309: a party could not advance their own order (% row(s)) — the fix went too far', n;
  end if;
  -- And the offer's own author may still withdraw it.
  update public.marketplace_offers set status = 'withdrawn' where id = off;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0309: the offer author could not withdraw their own offer (% row(s)) — the fix went too far', n;
  end if;

  reset role;
  raise notice '0309 OK: a party may advance their own deal and may not rewrite who the deal was with';
end $$;

-- ── The twenty policies that omit `with check` entirely are NOT this bug ─────
--
-- Censusing the fix above turned up 20 PERMISSIVE UPDATE/ALL policies in
-- `public` with a `using` clause and no `with check`, which looks like the same
-- defect and is not: PostgreSQL reuses `using` as the check when `with check`
-- is omitted. That is documented behaviour, and it is measured here rather than
-- cited — a documented behaviour this audit has never watched fail is still an
-- assumption, and the finding above exists because a `with check` clause was
-- read rather than exercised.
--
-- Two things are measured, because the second is the premise of the ratchet:
--   (a) in the real schema, a `using`-only UPDATE policy refuses a row that
--       leaves the caller's family;
--   (b) in isolation, writing `with check (true)` on such a policy switches
--       that refusal OFF — so "filling in the blank" with the permissive
--       identity is a real way to undo (a), which is what the ratchet forbids.
--
-- (a) alone would not establish (b). `todo_lists` also carries a second, older
-- `FOR ALL` policy, and its implicit check refuses the move independently — so
-- on that table the two guards are over-determined. That is exactly why (b)
-- gets its own table with exactly one applicable UPDATE policy.
do $$
declare
  fam_a uuid := 'f0309100-0000-4000-8000-00000000fa01';
  fam_b uuid := 'f0309100-0000-4000-8000-00000000fa02';
  usr   uuid := 'f0309100-0000-4000-8000-00000000c001';
  lst uuid; n int; refused boolean; offenders text; owner_after text;
begin
  insert into public.families (id, name) values
    (fam_a, '0309 using-as-check A'), (fam_b, '0309 using-as-check B') on conflict do nothing;
  insert into auth.users (id, email) values (usr, 'u0309b@example.test') on conflict do nothing;
  delete from public.todo_lists     where family_id in (fam_a, fam_b);
  delete from public.family_members where family_id in (fam_a, fam_b);
  -- A member of A only. B is a family they have no business writing into.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam_a, usr, 'Member', 'parent', true);
  insert into public.todo_lists (family_id, name) values (fam_a, '0309 list') returning id into lst;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', usr::text, true);

  -- (a) todo_lists_update is `using (is_family_member(family_id))` with no
  -- `with check`. If the omission meant "no check", this moves the row out of
  -- the family and into one the caller cannot even read.
  refused := false;
  begin
    update public.todo_lists set family_id = fam_b where id = lst;
  -- Only the RLS refusal counts; `when others` would let a renamed column
  -- report the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0309: a `using`-only UPDATE policy let a row be moved into another family';
  end if;
  reset role;

  -- (b) The same policy shape in isolation, with the blank filled in.
  drop table if exists public.zz_0309_using_as_check;
  create table public.zz_0309_using_as_check (id int primary key, owner text);
  alter table public.zz_0309_using_as_check enable row level security;
  insert into public.zz_0309_using_as_check values (1, 'authenticated');
  grant select, update on public.zz_0309_using_as_check to authenticated;
  -- A select policy so the UPDATE's WHERE can see the row at all; RLS with no
  -- SELECT policy hides it and the update matches zero rows, which would read
  -- as "refused" while proving nothing.
  create policy sel on public.zz_0309_using_as_check for select using (true);
  create policy upd on public.zz_0309_using_as_check for update using (owner = current_user);

  refused := false;
  begin
    set local role authenticated;
    update public.zz_0309_using_as_check set owner = 'someone_else' where id = 1;
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  if not refused then
    raise exception '0309: the isolated `using`-only policy did not check the new row — (a) proved nothing about the class';
  end if;

  alter policy upd on public.zz_0309_using_as_check with check (true);
  begin
    set local role authenticated;
    update public.zz_0309_using_as_check set owner = 'someone_else' where id = 1;
  exception when insufficient_privilege then null;
  end;
  reset role;
  select owner into owner_after from public.zz_0309_using_as_check where id = 1;
  if owner_after is distinct from 'someone_else' then
    raise exception '0309: `with check (true)` did NOT switch the implicit check off — the ratchet below is guarding a hazard that does not exist, and says something false about PostgreSQL';
  end if;
  drop table public.zz_0309_using_as_check;

  -- The ratchet. `true` as a permissive check is a check that passes always;
  -- service_role is exempt because it bypasses RLS regardless.
  select string_agg(tablename || '.' || policyname, ', ' order by tablename) into offenders
    from pg_policies
   where schemaname = 'public'
     and cmd in ('UPDATE', 'ALL')
     and permissive = 'PERMISSIVE'
     and btrim(coalesce(with_check, '')) in ('true', '(true)')
     and 'service_role' <> all(coalesce(roles, '{}'));
  if offenders is not null then
    raise exception '0309: permissive UPDATE/ALL policies write `with check (true)`, which switches the implicit `using` check off: %', offenders;
  end if;

  raise notice '0309 OK: an omitted `with check` is the `using` clause, measured both ways — and no policy overrides it with `true`';
end $$;
