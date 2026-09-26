-- Behavioural proof for 0326, run against the replayed schema.
--
-- `guardian_member_profiles.guardian_phone` is the only key the three inbound
-- Twilio webhooks have, and they resolve it ACROSS all families under the
-- service role. The write side guarded it within ONE family, on an RLS-bound
-- client that could not have seen another family's row in any case. So two
-- households could hold the same number, and `maybeSingle()` answers
-- `data: null` + PGRST116 on two rows — which all three routes read as "unknown
-- number" and answered 200 to, consuming the event.
--
-- This asserts the constraint from both directions: the clash is refused ACROSS
-- families (the case the app could never see), and everything legitimate still
-- works — many profiles with NO number, and a family reassigning a number it
-- already owns.
do $$
declare
  famA    uuid := 'aaaa5555-0000-4000-8000-00000000000a';
  famB    uuid := 'bbbb5555-0000-4000-8000-00000000000b';
  uidA    uuid := 'a5000000-0000-4000-8000-000000000001';
  uidB    uuid := 'b5000000-0000-4000-8000-000000000001';
  uidA2   uuid := 'a5000000-0000-4000-8000-000000000002';
  midA    uuid;
  midA2   uuid;
  midB    uuid;
  blocked boolean;
  n       int;
begin
  -- Re-runnable, and namespaced so no other probe's teardown can reach these.
  delete from public.guardian_member_profiles where family_id in (famA, famB);
  delete from public.family_members where user_id in (uidA, uidA2, uidB);
  delete from public.families where id in (famA, famB);

  insert into public.families (id, name) values (famA, 'Guardian A'), (famB, 'Guardian B');
  insert into auth.users (id, email) values
    (uidA, 'ga@example.test'), (uidA2, 'ga2@example.test'), (uidB, 'gb@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (famA, uidA, 'Parent A', 'parent', true) returning id into midA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (famA, uidA2, 'Gran A', 'adult', true) returning id into midA2;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (famB, uidB, 'Parent B', 'parent', true) returning id into midB;

  -- Family A claims a Guardian number.
  insert into public.guardian_member_profiles (family_id, member_id, guardian_phone)
  values (famA, midA, '+15550001111');
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a family can no longer claim a Guardian number (%)', n;
  end if;

  -- 1. Family B cannot claim the SAME number. This is the case the app's own
  --    check could never see: it is scoped to one family AND runs RLS-bound.
  blocked := false;
  begin
    insert into public.guardian_member_profiles (family_id, member_id, guardian_phone)
    values (famB, midB, '+15550001111');
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'two families hold the same Guardian number — every call to it is dropped and marked handled';
  end if;

  -- 2. Nor may a SECOND member of the same family, which is the narrower case
  --    the app did check. Both are now one constraint.
  blocked := false;
  begin
    insert into public.guardian_member_profiles (family_id, member_id, guardian_phone)
    values (famA, midA2, '+15550001111');
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'two members of one family hold the same Guardian number';
  end if;

  -- 3. The lookup the webhooks actually perform returns EXACTLY ONE row. This
  --    is the assertion that matters: `maybeSingle()` over two rows is what
  --    produced null-plus-a-dropped-error.
  select count(*) into n from public.guardian_member_profiles
  where guardian_phone = '+15550001111';
  if n <> 1 then
    raise exception 'the webhook lookup matches % rows, not 1', n;
  end if;

  -- ── Positive controls: nothing legitimate is lost ────────────────────────
  -- Many profiles with NO number is the normal state for members Guardian is
  -- not watching. The partial index must allow them.
  insert into public.guardian_member_profiles (family_id, member_id, guardian_phone)
  values (famA, midA2, null);
  insert into public.guardian_member_profiles (family_id, member_id, guardian_phone)
  values (famB, midB, null);
  select count(*) into n from public.guardian_member_profiles
  where family_id in (famA, famB) and guardian_phone is null;
  if n <> 2 then
    raise exception 'profiles without a Guardian number are being refused (% of 2)', n;
  end if;

  -- A family may still move its OWN number to another member, and re-save the
  -- same number on the same row.
  update public.guardian_member_profiles set guardian_phone = null where family_id = famA and member_id = midA;
  update public.guardian_member_profiles set guardian_phone = '+15550001111' where family_id = famA and member_id = midA2;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a family can no longer move its own Guardian number (%)', n;
  end if;
  update public.guardian_member_profiles set guardian_phone = '+15550001111' where family_id = famA and member_id = midA2;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 're-saving the same number on the same row is refused (%)', n;
  end if;

  -- And family B may claim a DIFFERENT number, which is the whole point.
  update public.guardian_member_profiles set guardian_phone = '+15550002222' where family_id = famB and member_id = midB;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a second family can no longer claim its own Guardian number (%)', n;
  end if;

  raise notice 'guardian-number-uniqueness-check OK: one number, one family; unclaimed profiles and legitimate moves still work';
end $$;
