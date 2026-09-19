-- ── 0322: a review belongs to whoever wrote it ──────────────────────────────
--
-- 0154 pins `reviewer_member` on INSERT so a trust score cannot be forged. The
-- UPDATE policy beside it was `using/with check (is_family_member(family_id))`
-- — not even scoped to the row's author — so any member of the family could
-- rewrite any review: the rating shown on the item page, the creator profile
-- and the creators index, and `reviewee_member`, which decides whose rating it
-- is. Same for marketplace_saves and marketplace_follows, whose INSERT policies
-- pin `member_id` for the same reason.
--
-- Measured before 0322: a member rewrote another member's one-star review of
-- them into five stars, and reassigned it to a third member.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/marketplace-review-authorship-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S6-09.
do $$
declare
  fam uuid := 'f0322000-0000-4000-8000-00000000fa01';
  ua  uuid := 'f0322000-0000-4000-8000-00000000c001';
  uc  uuid := 'f0322000-0000-4000-8000-00000000c003';
  ma uuid; mc uuid; lst uuid; str uuid; rev uuid; fol uuid; sav uuid;
  n int; refused boolean; got int;
begin
  insert into public.families (id, name) values (fam, '0322 review authorship') on conflict do nothing;
  insert into auth.users (id, email) values
    (ua, 'a0322@example.test'), (uc, 'c0322@example.test') on conflict do nothing;
  delete from public.marketplace_reviews  where family_id = fam;
  delete from public.marketplace_follows  where family_id = fam;
  delete from public.marketplace_saves    where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.marketplace_stores   where family_id = fam;
  delete from public.family_members       where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, ua, 'Author A', 'parent', true) returning id into ma;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uc, 'Subject C', 'parent', true) returning id into mc;

  insert into public.marketplace_listings (family_id, member_id, title, kind, category, price_cents, status)
    values (fam, mc, 'Bike', 'sell', 'sports', 5000, 'available') returning id into lst;
  insert into public.marketplace_stores (family_id, member_id, name)
    values (fam, mc, 'C''s store') returning id into str;
  -- A reviewed C, and thought little of the transaction.
  insert into public.marketplace_reviews (family_id, listing_id, reviewer_member, reviewee_member, role, rating, comment)
    values (fam, lst, ma, mc, 'buyer', 1, 'Late and damaged') returning id into rev;
  insert into public.marketplace_follows (family_id, store_id, member_id)
    values (fam, str, ma) returning id into fol;
  insert into public.marketplace_saves (family_id, listing_id, member_id)
    values (fam, lst, ma) returning id into sav;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uc::text, true);
  if auth.uid() is distinct from uc then
    raise exception '0322: impersonation failed — auth.uid() is %, expected the review''s subject', auth.uid();
  end if;

  -- ── The subject of a review is not its author ─────────────────────────────
  update public.marketplace_reviews set rating = 5, comment = 'Delightful' where id = rev;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0322: the SUBJECT of a review rewrote its rating (% row(s))', n;
  end if;
  select rating into got from public.marketplace_reviews where id = rev;
  if got is distinct from 1 then
    raise exception '0322: the one-star review now reads % stars', got;
  end if;

  -- Nor may they take someone else's rows.
  update public.marketplace_follows set member_id = mc where id = fol;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0322: a member rewrote another member''s follow (% row(s))', n;
  end if;
  update public.marketplace_saves set member_id = mc where id = sav;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0322: a member rewrote another member''s save (% row(s))', n;
  end if;

  -- ── The author may revise their own, and may not move it ──────────────────
  perform set_config('request.jwt.claim.sub', ua::text, true);
  if auth.uid() is distinct from ua then
    raise exception '0322: impersonation failed — auth.uid() is %, expected the author', auth.uid();
  end if;

  update public.marketplace_reviews set rating = 3, comment = 'Sorted it out' where id = rev;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0322: the AUTHOR could not revise their own review (% row(s)) — the fix went too far', n;
  end if;

  refused := false;
  begin
    update public.marketplace_reviews set reviewee_member = ma where id = rev;
  -- Only the refusal counts; `when others` would let a renamed column report
  -- the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0322: an author re-pointed their review at a different member';
  end if;

  reset role;
  raise notice '0322 OK: the author may revise a review, the subject may not, and nobody may move one';
end $$;

-- ── The immutability helper refuses to guard a column that does not exist ───
--
-- `columns_are_immutable()` takes its column list from the trigger definition.
-- A typo there would compare NULL to NULL on every row and report the boundary
-- as held while guarding nothing — the exact defect class this audit exists to
-- find, planted in the fix for it. The helper raises instead, and this measures
-- that rather than trusting the branch is reachable.
do $$
declare
  fam uuid := 'f0322100-0000-4000-8000-00000000fa01';
  usr uuid := 'f0322100-0000-4000-8000-00000000c001';
  lst uuid; caught text;
begin
  insert into public.families (id, name) values (fam, '0322 typo guard') on conflict do nothing;
  insert into auth.users (id, email) values (usr, 'u0322b@example.test') on conflict do nothing;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members       where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, usr, 'Member', 'parent', true);
  insert into public.marketplace_listings (family_id, member_id, title, kind, category, price_cents, status)
    select fam, id, 'Probe', 'sell', 'other', 100, 'available'
      from public.family_members where family_id = fam returning id into lst;

  create trigger zz_0322_typo
    before update on public.marketplace_listings
    for each row execute function public.columns_are_immutable('sellar_member');
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', usr::text, true);
    update public.marketplace_listings set title = 'Probe 2' where id = lst;
    caught := null;
  exception when others then caught := sqlerrm;
  end;
  reset role;
  drop trigger zz_0322_typo on public.marketplace_listings;
  delete from public.marketplace_listings where family_id = fam;

  if caught is null or caught not like '%names a column that does not exist%' then
    raise exception '0322: a misspelled immutable column passed silently (%) — the guard cannot fail', coalesce(caught, 'no error');
  end if;
  raise notice '0322 OK: a misspelled immutable column raises instead of guarding nothing';
end $$;
