-- Behavioural proof for 0318, run as real `authenticated` sessions under RLS.
--
-- Removing someone from a household is `update({ is_active: false })` on their
-- `family_members` row (family-module.tsx:483, settings-module.tsx:181,
-- admin/actions.ts:200). Their auth user survives, their session survives, and
-- nothing signs them out.
--
-- Eleven tables decided membership with an inline subquery that never mentions
-- `is_active`. They were nonetheless closed, because that subquery reads
-- `public.family_members` as the CALLING user and so is filtered by
-- `fm_select` — which does check it. Eleven tables held shut by a policy on a
-- twelfth, for a reason none of them states.
--
-- This probe therefore asserts the boundary TWICE: once as the database stands,
-- and once with `fm_select` deliberately widened to admit an inactive
-- membership — the shape `audit/claude-4.md:1596` would need if its
-- "you were removed" interstitial were built on the session client. The second
-- assertion is the one that fails without 0318, and it is the whole reason this
-- file exists.
--
-- No blanket `grant ... on all tables in schema public`: the bootstrap's
-- `alter default privileges` already gives the client roles DML on every table
-- a migration creates, and restating it would undo later deliberate revokes for
-- every probe that runs after this one.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'ffff7777-0000-4000-8000-00000000000a';
  here_uid   uuid := 'f7000000-0000-4000-8000-000000000001';
  gone_uid   uuid := 'f7000000-0000-4000-8000-000000000002';
  here_mid   uuid;
  conv       uuid;
  fm_select_was text;
  n          int;

  -- Every table 0318 rewrote that is family-scoped and seeded below. Asserted
  -- as a set rather than one at a time so a table added to the migration and
  -- forgotten here shows up as a missing row count, not as silence.
  tables text[] := array[
    'family_albums', 'family_contacts', 'family_conversations', 'family_messages',
    'family_photos', 'family_recipes', 'family_reminders', 'family_tree_nodes',
    'todo_items', 'todo_lists'
  ];
  tbl text;
begin
  -- Re-runnable, with identifiers of its own so a sibling probe's teardown
  -- cannot reach in.
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.family_messages      where family_id = fam;
  delete from public.family_conversations where family_id = fam;
  delete from public.family_photos        where family_id = fam;
  delete from public.family_albums        where family_id = fam;
  delete from public.family_contacts      where family_id = fam;
  delete from public.family_recipes       where family_id = fam;
  delete from public.family_reminders     where family_id = fam;
  delete from public.family_tree_nodes    where family_id = fam;
  delete from public.todo_items           where family_id = fam;
  delete from public.todo_lists           where family_id = fam;
  delete from public.family_members       where user_id in (here_uid, gone_uid);
  delete from public.families             where id = fam;

  insert into public.families (id, name) values (fam, 'Still here');
  insert into auth.users (id, email) values
    (here_uid, 'rh@example.test'), (gone_uid, 'rg@example.test') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, here_uid, 'Here', 'parent', true) returning id into here_mid;
  -- The removal, exactly as the product performs it.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, gone_uid, 'Gone', 'adult', false);

  insert into public.family_conversations (family_id, name, kind, created_by)
  values (fam, 'Family chat', 'group', here_uid) returning id into conv;
  insert into public.family_messages (family_id, conversation_id, sender_id, content)
  values (fam, conv, here_uid, 'the thing we did not want them to read');
  insert into public.family_albums   (family_id, name, created_by) values (fam, 'Summer', here_uid);
  insert into public.family_photos   (family_id, storage_path, uploaded_by) values (fam, 'fam/1.jpg', here_uid);
  insert into public.family_contacts (family_id, name, relationship, category, phone, created_by)
  values (fam, 'Dr Alvarez', 'doctor', 'doctor', '555-0100', here_uid);
  insert into public.family_recipes  (family_id, name, created_by) values (fam, 'Pancakes', here_uid);
  insert into public.family_reminders(family_id, title, created_by) values (fam, 'Bins out', here_uid);
  insert into public.family_tree_nodes (family_id, name, relationship) values (fam, 'Grandad', 'grandparent');
  insert into public.todo_lists      (family_id, name, created_by) values (fam, 'House', here_mid);
  insert into public.todo_items      (family_id, list_id, title, created_by)
  values (fam, (select id from public.todo_lists where family_id = fam limit 1), 'Fix the gate', here_mid);

  -- ══ POSITIVE CONTROLS FIRST ════════════════════════════════════════════
  -- The member who is still in the family reads every one of them, and writes.
  -- Without this, "nobody can read anything" would also pass.
  perform set_config('request.jwt.claim.sub', here_uid::text, true);
  set local role authenticated;
  foreach tbl in array tables loop
    execute format('select count(*) from public.%I where family_id = $1', tbl)
      into n using fam;
    if n <> 1 then
      raise exception 'a CURRENT member reads % rows of %, expected 1 — the boundary is too tight', n, tbl;
    end if;
  end loop;

  insert into public.family_messages (family_id, conversation_id, sender_id, content)
  values (fam, conv, here_uid, 'a current member still posts');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a current member can no longer post to the family chat'; end if;
  reset role;

  -- ══ THE BOUNDARY, AS THE DATABASE STANDS ═══════════════════════════════
  perform set_config('request.jwt.claim.sub', gone_uid::text, true);
  set local role authenticated;
  foreach tbl in array tables loop
    execute format('select count(*) from public.%I where family_id = $1', tbl)
      into n using fam;
    if n <> 0 then
      raise exception 'a REMOVED member reads % rows of %', n, tbl;
    end if;
  end loop;

  begin
    insert into public.family_messages (family_id, conversation_id, sender_id, content)
    values (fam, conv, gone_uid, 'posted by someone who was removed');
    raise exception 'a removed member posted to the family chat';
  exception when insufficient_privilege then
    null;
  end;

  delete from public.todo_lists where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a removed member deleted the family to-do list (%)', n; end if;
  reset role;

  -- ══ THE SAME BOUNDARY, WITHOUT ITS ACCIDENTAL PROP ═════════════════════
  -- Widen `fm_select` to admit an inactive membership — the read a
  -- "you are no longer part of this family" screen needs if it is ever built on
  -- the session client rather than the service client. Before 0318 this ALONE
  -- reopened all ten tables, because their predicates delegated the `is_active`
  -- question to this policy. `alter policy` keeps the command and the roles, so
  -- only the expression moves; the original is captured and restored below, and
  -- an exception anywhere in this block rolls the whole DO back, which is why
  -- the widening cannot escape this file.
  select pg_get_expr(polqual, polrelid) into fm_select_was
  from pg_policy where polrelid = 'public.family_members'::regclass and polname = 'fm_select';
  if fm_select_was is null then
    raise exception 'fm_select is gone — this probe is asserting against a policy that no longer exists';
  end if;

  -- The minimal widening that screen needs: let a caller see their OWN
  -- membership row whether or not it is still active. Written with
  -- `is_family_member` for the family-wide half because that function is
  -- security definer — a policy on `family_members` that reads
  -- `family_members` directly recurses.
  alter policy fm_select on public.family_members
    using (user_id = auth.uid() or public.is_family_member(family_id));

  perform set_config('request.jwt.claim.sub', gone_uid::text, true);
  set local role authenticated;

  -- Control for the control: the widening must actually have taken, or the
  -- assertion below would pass by doing nothing.
  select count(*) into n from public.family_members where user_id = gone_uid;
  if n <> 1 then
    raise exception 'the widened fm_select did not take (% rows) — the assertion that follows would prove nothing', n;
  end if;

  foreach tbl in array tables loop
    execute format('select count(*) from public.%I where family_id = $1', tbl)
      into n using fam;
    if n <> 0 then
      raise exception
        'with fm_select widened, a removed member reads % rows of % — the policy is delegating its is_active check to another table',
        n, tbl;
    end if;
  end loop;
  reset role;

  execute format('alter policy fm_select on public.family_members using (%s)', fm_select_was);
  if (select pg_get_expr(polqual, polrelid) from pg_policy
      where polrelid = 'public.family_members'::regclass and polname = 'fm_select') is distinct from fm_select_was then
    raise exception 'fm_select was not restored to its original expression';
  end if;

  -- ══ TEARDOWN ═══════════════════════════════════════════════════════════
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.family_messages      where family_id = fam;
  delete from public.family_conversations where family_id = fam;
  delete from public.family_photos        where family_id = fam;
  delete from public.family_albums        where family_id = fam;
  delete from public.family_contacts      where family_id = fam;
  delete from public.family_recipes       where family_id = fam;
  delete from public.family_reminders     where family_id = fam;
  delete from public.family_tree_nodes    where family_id = fam;
  delete from public.todo_items           where family_id = fam;
  delete from public.todo_lists           where family_id = fam;
  delete from public.family_members       where user_id in (here_uid, gone_uid);
  delete from public.families             where id = fam;

  raise notice '0318 removed-member boundary: holds as the schema stands, and holds with fm_select widened';
end $$;
