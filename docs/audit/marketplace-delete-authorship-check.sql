-- ── 0316: deleting a review is rewriting it ─────────────────────────────────
--
-- 0315 stopped a member rewriting another member's review; the DELETE policies
-- beside it were still family-wide, and for a one-star review about yourself
-- deleting it and rewriting it are the same act with the same result on the same
-- four screens. Same for offers: any member could remove a competing offer on a
-- listing they have nothing to do with.
--
-- Measured before 0316:
--   the SUBJECT of a review deleted it (1 row)
--   a stranger to a listing deleted a competing offer on it (1 row)
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/marketplace-delete-authorship-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S6-10.
do $$
declare
  fam uuid := 'f0316000-0000-4000-8000-00000000fa01';
  ua  uuid := 'f0316000-0000-4000-8000-00000000c001';  -- author / seller, parent
  uc  uuid := 'f0316000-0000-4000-8000-00000000c003';  -- review subject, parent
  uk  uuid := 'f0316000-0000-4000-8000-00000000c005';  -- an uninvolved child
  ma uuid; mc uuid; mk uuid; lst uuid; str uuid; rev uuid; off uuid; sav uuid; fol uuid;
  n int;
begin
  insert into public.families (id, name) values (fam, '0316 delete authorship') on conflict do nothing;
  insert into auth.users (id, email) values
    (ua, 'a0316@example.test'), (uc, 'c0316@example.test'), (uk, 'k0316@example.test')
    on conflict do nothing;
  delete from public.marketplace_reviews  where family_id = fam;
  delete from public.marketplace_offers   where family_id = fam;
  delete from public.marketplace_follows  where family_id = fam;
  delete from public.marketplace_saves    where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.marketplace_stores   where family_id = fam;
  delete from public.family_members       where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, ua, 'Author A', 'parent', true) returning id into ma;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uc, 'Subject C', 'parent', true) returning id into mc;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uk, 'Kid K', 'child', true) returning id into mk;

  -- C sells; A reviewed C badly; K made an offer on C's listing.
  insert into public.marketplace_listings (family_id, member_id, title, kind, category, price_cents, status)
    values (fam, mc, 'Bike', 'sell', 'sports', 5000, 'available') returning id into lst;
  insert into public.marketplace_stores (family_id, member_id, name)
    values (fam, mc, 'C''s store') returning id into str;
  insert into public.marketplace_reviews (family_id, listing_id, reviewer_member, reviewee_member, role, rating, comment)
    values (fam, lst, ma, mc, 'buyer', 1, 'Late and damaged') returning id into rev;
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status)
    values (fam, lst, mk, 'offer', 'open') returning id into off;
  insert into public.marketplace_saves (family_id, listing_id, member_id)
    values (fam, lst, ma) returning id into sav;
  insert into public.marketplace_follows (family_id, store_id, member_id)
    values (fam, str, ma) returning id into fol;

  -- ── The subject of a review may not erase it ──────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uc::text, true);
  if auth.uid() is distinct from uc then
    raise exception '0316: impersonation failed — auth.uid() is %, expected the review''s subject', auth.uid();
  end if;

  delete from public.marketplace_reviews where id = rev;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0316: the SUBJECT of a review deleted it (% row(s)) — and they are a MANAGER, which is the loophole the predicate names', n;
  end if;

  -- Nor another member's saves and follows.
  delete from public.marketplace_saves where id = sav;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0316: a member deleted another member''s save (% row(s))', n;
  end if;
  delete from public.marketplace_follows where id = fol;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0316: a member deleted another member''s follow (% row(s))', n;
  end if;

  -- ── A member with no stake in a listing may not remove an offer on it ─────
  perform set_config('request.jwt.claim.sub', ua::text, true);
  delete from public.marketplace_offers where id = off;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0316: a member with no stake in the listing deleted a competing offer (% row(s))', n;
  end if;

  -- ── What must still work ──────────────────────────────────────────────────
  -- The listing owner may clear an offer on their own listing.
  perform set_config('request.jwt.claim.sub', uc::text, true);
  delete from public.marketplace_offers where id = off;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0316: the LISTING OWNER could not remove an offer on their own listing (% row(s)) — the fix went too far', n;
  end if;

  -- toggleSaveAction / toggleFollowAction delete their own row.
  perform set_config('request.jwt.claim.sub', ua::text, true);
  delete from public.marketplace_saves where id = sav;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0316: a member could not un-save their own listing (% row(s)) — toggleSaveAction is broken', n;
  end if;
  delete from public.marketplace_follows where id = fol;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0316: a member could not unfollow their own store (% row(s)) — toggleFollowAction is broken', n;
  end if;

  -- The author may withdraw their own review.
  delete from public.marketplace_reviews where id = rev;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0316: the AUTHOR could not delete their own review (% row(s)) — the fix went too far', n;
  end if;

  -- ── And a manager may still moderate a review that is not about them ──────
  -- This is the deliberate half of the predicate: without it a parent cannot
  -- remove an abusive review written by a child. Seeded fresh: K reviews A, and
  -- C — a manager, uninvolved — removes it.
  reset role;
  insert into public.marketplace_reviews (family_id, listing_id, reviewer_member, reviewee_member, role, rating, comment)
    values (fam, lst, mk, ma, 'buyer', 1, 'Something a parent would remove') returning id into rev;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uc::text, true);
  delete from public.marketplace_reviews where id = rev;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0316: a MANAGER could not moderate a review that is not about them (% row(s)) — the fix went too far', n;
  end if;

  reset role;
  raise notice '0316 OK: an author may withdraw their review, a manager may moderate one that is not about them, and the subject may do neither';
end $$;
