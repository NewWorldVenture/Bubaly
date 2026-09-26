-- Behavioural proof for 0338, run as real `authenticated` sessions under RLS.
--
-- The Independence Ladder is a parent's record of what a child is trusted to
-- do. Before 0338 every member could write it — the child it is about
-- included — so a child could mark their own milestones achieved, skip the
-- ones they would rather not do, start milestones on a sibling's track, or
-- delete one. A child must still SEE their ladder: that is the point of it.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'aaa70000-0000-4000-8000-00000000005c';
  parent_uid uuid := 'aaa70000-0000-4000-8000-000000000001';
  child_uid  uuid := 'aaa70000-0000-4000-8000-000000000002';
  sib_uid    uuid := 'aaa70000-0000-4000-8000-000000000003';
  parent_mid uuid;
  child_mid  uuid;
  sib_mid    uuid;
  own        uuid;
  sibs       uuid;
  refused    boolean;
  n          int;
begin
  insert into public.families (id, name) values (fam, 'Ladder') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'lad-p@example.test'), (child_uid, 'lad-c@example.test'), (sib_uid, 'lad-s@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, sib_uid, 'Sibling', 'child', true) returning id into sib_mid;

  -- ── As the parent: the ladder is theirs to move ───────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  insert into public.independence_milestones (family_id, member_id, domain, title, age_band, status, points, created_by)
    values (fam, child_mid, 'chores', 'Makes their own lunch', '7-9', 'in_progress', 10, parent_uid) returning id into own;
  insert into public.independence_milestones (family_id, member_id, domain, title, age_band, status, points, created_by)
    values (fam, sib_mid, 'chores', 'Walks the dog', '7-9', 'in_progress', 10, parent_uid) returning id into sibs;
  reset role;

  -- ── As the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Still sees the ladder.
  select count(*) into n from public.independence_milestones where family_id = fam;
  if n <> 2 then raise exception 'a child could not read the family ladder (% rows)', n; end if;

  -- 2. Cannot mark their own milestone achieved (filtered: zero rows move).
  update public.independence_milestones set status = 'achieved', achieved_at = now() where id = own;
  select count(*) into n from public.independence_milestones where id = own and status = 'achieved';
  if n <> 0 then raise exception 'a child marked their own milestone achieved'; end if;

  -- 3. Cannot skip it either.
  update public.independence_milestones set status = 'skipped' where id = own;
  select count(*) into n from public.independence_milestones where id = own and status = 'skipped';
  if n <> 0 then raise exception 'a child skipped a milestone on their own ladder'; end if;

  -- 4. Cannot start a milestone on anyone's track.
  refused := false;
  begin
    insert into public.independence_milestones (family_id, member_id, domain, title, age_band, status, points, created_by)
      values (fam, sib_mid, 'chores', 'Cleans the bathroom', '7-9', 'in_progress', 10, child_uid);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a child started a milestone on a sibling''s ladder'; end if;

  -- 5. Cannot delete a sibling's milestone.
  delete from public.independence_milestones where id = sibs;
  reset role;
  select count(*) into n from public.independence_milestones where id = sibs;
  if n <> 1 then raise exception 'a child deleted a sibling''s milestone'; end if;

  -- ── As the parent again: still marks and removes ─────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  update public.independence_milestones set status = 'achieved', achieved_at = now() where id = own;
  delete from public.independence_milestones where id = sibs;
  reset role;
  select count(*) into n from public.independence_milestones where id = own and status = 'achieved';
  if n <> 1 then raise exception 'a parent could not mark a milestone achieved'; end if;
  select count(*) into n from public.independence_milestones where id = sibs;
  if n <> 0 then raise exception 'a parent could not remove a milestone'; end if;

  raise notice 'OK  the independence ladder is a parent''s to move; the child still sees it';
end $$;
