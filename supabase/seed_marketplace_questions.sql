-- ============================================================================
-- seed_marketplace_questions.sql — ~400 marketplace Q&A rows to exercise the
-- listing Q&A + the Questions inbox. One question per seeded listing; ~half are
-- answered by that listing's owner. Run supabase/seed_marketplace.sql FIRST.
--
-- Resolves the same family (owner email). IDEMPOTENT: wipes this family's
-- marketplace_questions, then inserts. Test data only, one family. Safe to re-run.
--
-- HOW TO RUN: Supabase SQL editor → paste → Run → open any listing or
--   /marketplace/questions.
-- ============================================================================

do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_uid     uuid;
  v_members uuid[];
  mcount    int;
  qs text[] := array[
    'Is this still available?','Would you consider a lower price?','Can I pick it up this weekend?',
    'What condition is it in?','Are there any flaws or damage?','Does it come with everything shown?',
    'How old is it?','Is delivery possible?'];
  ans text[] := array[
    'Yes, still available!','Sure, make me an offer.','Weekend pickup works great.',
    'Excellent condition, barely used.','No flaws — well cared for.','Yes, everything is included.',
    'About a year old.','Pickup only, sorry.'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_family and is_active;
  mcount := coalesce(array_length(v_members, 1), 0);
  if mcount = 0 then raise exception 'Family has no members.'; end if;

  delete from public.marketplace_questions where family_id = v_family;

  with base as (
    select l.id as listing_id, l.member_id as owner,
           row_number() over (order by l.created_at desc)::int as rn
    from public.marketplace_listings l
    where l.family_id = v_family
    limit 400
  )
  insert into public.marketplace_questions
    (family_id, listing_id, asker_member, question, answer, answered_at, answered_by, created_by)
  select
    v_family, b.listing_id,
    v_members[1 + (b.rn % mcount)],
    qs[1 + (b.rn % array_length(qs, 1))],
    case when b.rn % 2 = 0 then ans[1 + (b.rn % array_length(ans, 1))] else null end,
    case when b.rn % 2 = 0 then now() - make_interval(days => (b.rn % 20)) else null end,
    case when b.rn % 2 = 0 then b.owner else null end,
    v_uid
  from base b;

  raise notice 'Marketplace questions seed complete for family %.', v_family;
end $$;

-- ── Verify: total + answered split ──────────────────────────────────────────
select 'questions' as metric, count(*)::text as value from public.marketplace_questions
  where family_id = (select f.id from public.families f join public.family_members fm on fm.family_id=f.id join auth.users u on u.id=fm.user_id where lower(u.email)=lower('newworldventurellc@gmail.com') limit 1)
union all
select 'answered', count(*)::text from public.marketplace_questions
  where family_id = (select f.id from public.families f join public.family_members fm on fm.family_id=f.id join auth.users u on u.id=fm.user_id where lower(u.email)=lower('newworldventurellc@gmail.com') limit 1) and answer is not null;
