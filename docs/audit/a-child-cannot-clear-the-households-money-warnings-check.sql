-- ── A child cannot clear the household's money warnings (0352) ──────────────
--
-- `money_timeline_insights` (0168) carries `unique (family_id, dedupe_key)`, so
-- there is ONE acknowledge/dismiss status per family per Financial Copilot
-- advisory, and every member's /dashboard/money-timeline renders from it. 0168
-- gated all four commands on `is_family_member` — membership, not role — so a
-- child on a kid login or an invited guest could dismiss the `urgent`
-- low-balance warning for the parents too, or delete the row outright. 0352
-- makes the three writes manager-only and backs them with restrictive guards.
--
-- tests/a-child-cannot-clear-the-households-money-warnings.test.ts proves the
-- server action's `isManager` refusal and reads 0352's text; it runs on an
-- in-memory client with no policy engine, so it cannot show that Postgres
-- itself refuses the write. This probe is that half. It asserts:
--
--   1. a child running the EXACT upsert the Dismiss button sends
--      (`insert … on conflict (family_id, dedupe_key) do update`) is refused,
--      and the parents' row still reads 'active';
--   2. a child's plain UPDATE and DELETE touch nothing, and a child cannot
--      INSERT a pre-dismissed row for a week the copilot has not raised;
--   3. a guest is held the same way;
--   4. reads are untouched — 0267's documented decision, restated in 0352's
--      header: the child still sees the warning;
--   5. POSITIVE CONTROL: a parent's dismiss lands, and a parent can still
--      delete — the guard is a role rule, not a lock on everyone;
--   6. `anon` holds no INSERT/UPDATE/DELETE (the guards are `to authenticated`
--      and do not apply to an anonymous request; 0290's argument);
--   7. NEGATIVE CONTROL: put 0168's membership-only policies back and drop
--      0352's guards, and require the child's dismiss and delete to succeed
--      again — so this probe has been shown to see the defect it guards.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a
-- constraint violation is one RLS LET THROUGH; those are reported as breaches.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-child-cannot-clear-the-households-money-warnings-check.sql

\set FA '00000000-0000-4000-8000-000000035201'
\set UP '00000000-0000-4000-8000-000000035202'
\set UK '00000000-0000-4000-8000-000000035203'
\set UG '00000000-0000-4000-8000-000000035204'

begin;

insert into auth.users (id, email) values (:'UP','mti-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','mti-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UG','mti-guest@example.com')  on conflict do nothing;

-- handle_new_family() makes the creator a 'parent' member.
insert into public.families (id, name, created_by) values (:'FA','Copilot House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-000000035205',:'FA',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-000000035206',:'FA',:'UG','Guest','guest',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

-- The urgent advisory the parents are relying on, and one the family already
-- acknowledged (the record a delete would erase).
insert into public.money_timeline_insights (id, family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
  values ('00000000-0000-4000-8000-000000035207', :'FA', 'low_balance', 'Balance runs thin the week of Mar 2',
          'At the current pace your balance dips below zero the week of Mar 2.', 'urgent', '2026-03-02', -140,
          'active', 'low_balance:2026-03-02');
insert into public.money_timeline_insights (id, family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
  values ('00000000-0000-4000-8000-000000035208', :'FA', 'heavy_week', 'A heavy money week is coming',
          'Three bills land the week of Mar 9.', 'watch', '2026-03-09', 820,
          'acknowledged', 'heavy_week:2026-03-09');

do $$
declare
  n          int;
  st         text;
  failures   text[] := '{}';
  fam        constant uuid := '00000000-0000-4000-8000-000000035201';
  parent_u   constant uuid := '00000000-0000-4000-8000-000000035202';
  kid_u      constant uuid := '00000000-0000-4000-8000-000000035203';
  guest_u    constant uuid := '00000000-0000-4000-8000-000000035204';
  warning    constant uuid := '00000000-0000-4000-8000-000000035207';
  noted      constant uuid := '00000000-0000-4000-8000-000000035208';
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 4. Reads stay open, deliberately. Checked FIRST, before any write is
  --    attempted, so it measures the read policy and nothing else.
  select count(*) into n from public.money_timeline_insights where family_id = fam;
  if n <> 2 then
    failures := array_append(failures, format('a CHILD now reads %s of the family''s 2 advisories — reads are 0267''s documented decision; changing them is a product call, not this boundary', n));
  end if;

  -- 1. The Dismiss button's own statement (actions.ts: upsert, onConflict
  --    'family_id,dedupe_key', every column plus status).
  begin
    insert into public.money_timeline_insights
      (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (fam, 'low_balance', 'Balance runs thin the week of Mar 2',
       'At the current pace your balance dips below zero the week of Mar 2.', 'urgent', '2026-03-02', -140,
       'dismissed', 'low_balance:2026-03-02')
    on conflict (family_id, dedupe_key) do update
      set kind = excluded.kind, title = excluded.title, detail = excluded.detail,
          severity = excluded.severity, week_start = excluded.week_start,
          amount = excluded.amount, status = excluded.status;
    failures := array_append(failures, 'a CHILD''s Dismiss upsert was accepted — the household''s shortfall warning is theirs to clear');
  exception when insufficient_privilege then null;
  end;

  -- 2. The plain writes.
  update public.money_timeline_insights set status = 'dismissed' where id = warning;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a CHILD dismissed %s advisory row(s) for the whole family', n)); end if;

  delete from public.money_timeline_insights where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a CHILD deleted %s advisory row(s) — the family''s acknowledge/dismiss record', n)); end if;

  begin
    insert into public.money_timeline_insights (family_id, kind, title, detail, severity, week_start, status, dedupe_key)
      values (fam, 'low_balance', 'Not raised yet', 'A week the copilot has not surfaced', 'urgent', '2027-01-04',
              'dismissed', 'low_balance:2027-01-04');
    failures := array_append(failures, 'a CHILD pre-dismissed a warning for a week the copilot has not raised');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a CHILD''s pre-dismiss INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- ── As the guest ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', guest_u::text, true);

  update public.money_timeline_insights set status = 'dismissed' where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a GUEST dismissed %s advisory row(s) for the whole family', n)); end if;

  delete from public.money_timeline_insights where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a GUEST deleted %s advisory row(s)', n)); end if;

  -- Nothing the child or guest did reached the row the parents read.
  perform set_config('role','postgres', true);
  select status into st from public.money_timeline_insights where id = warning;
  if st is distinct from 'active' then
    failures := array_append(failures, format('the parents'' shortfall warning now reads %L after a child and a guest tried to clear it', st));
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  begin
    insert into public.money_timeline_insights
      (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (fam, 'low_balance', 'Balance runs thin the week of Mar 2',
       'At the current pace your balance dips below zero the week of Mar 2.', 'urgent', '2026-03-02', -140,
       'dismissed', 'low_balance:2026-03-02')
    on conflict (family_id, dedupe_key) do update
      set kind = excluded.kind, title = excluded.title, detail = excluded.detail,
          severity = excluded.severity, week_start = excluded.week_start,
          amount = excluded.amount, status = excluded.status;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT''s Dismiss upsert was refused — the guard locks out the people it is for');
  end;

  delete from public.money_timeline_insights where id = noted;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a PARENT could not delete an advisory (%s rows)', n)); end if;

  perform set_config('role','postgres', true);
  select status into st from public.money_timeline_insights where id = warning;
  if st is distinct from 'dismissed' then
    failures := array_append(failures, format('a PARENT''s dismiss did not land (status %L)', st));
  end if;

  -- 6. The grant layer, which `to authenticated` guards cannot reach.
  if has_table_privilege('anon', 'public.money_timeline_insights', 'INSERT')
     or has_table_privilege('anon', 'public.money_timeline_insights', 'UPDATE')
     or has_table_privilege('anon', 'public.money_timeline_insights', 'DELETE') then
    failures := array_append(failures, 'anon holds a write privilege on money_timeline_insights — the 0352 guards are `to authenticated` and would not apply');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Back to 0168 exactly: its membership-only write policies, no guards.
  update public.money_timeline_insights set status = 'active' where id = warning;

  drop policy if exists money_timeline_insights_manager_insert_guard on public.money_timeline_insights;
  drop policy if exists money_timeline_insights_manager_update_guard on public.money_timeline_insights;
  drop policy if exists money_timeline_insights_manager_delete_guard on public.money_timeline_insights;
  drop policy if exists money_timeline_insights_insert on public.money_timeline_insights;
  create policy money_timeline_insights_insert on public.money_timeline_insights
    for insert with check (public.is_family_member(family_id));
  drop policy if exists money_timeline_insights_update on public.money_timeline_insights;
  create policy money_timeline_insights_update on public.money_timeline_insights
    for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
  drop policy if exists money_timeline_insights_delete on public.money_timeline_insights;
  create policy money_timeline_insights_delete on public.money_timeline_insights
    for delete using (public.is_family_member(family_id));

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  begin
    insert into public.money_timeline_insights
      (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (fam, 'low_balance', 'Balance runs thin the week of Mar 2',
       'At the current pace your balance dips below zero the week of Mar 2.', 'urgent', '2026-03-02', -140,
       'dismissed', 'low_balance:2026-03-02')
    on conflict (family_id, dedupe_key) do update set status = excluded.status;
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0168''s policies alone the child STILL could not dismiss — this probe is decoration, not a boundary');
  end;

  delete from public.money_timeline_insights where id = warning;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0168''s policies alone the child STILL could not delete — this probe has never been shown to fail');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'the household''s money warnings are not held the way 0352 claims:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-child-cannot-clear-the-households-money-warnings: OK (a child''s and a guest''s dismiss, update, delete and pre-dismiss are refused, the parents'' row still reads active, reads are untouched, a parent''s dismiss and delete land, anon holds no write, negative control reproduced both escalations)';
end $$;

rollback;
