-- ── A household ledger entry names the member who actually logged it (0338) ──
--
-- Four ledgers — `care_log` (0032), `screen_time_entries` (0074),
-- `behavior_logs` (00730) and `medication_doses` (00261) — each carried
-- exactly one policy, `FOR ALL … is_family_member(family_id)`, pinning no
-- column. `logged_by` was therefore the writer's choice.
--
-- `care_log` is the one that reaches a screen. components/modules/
-- care-module.tsx:253 renders `{e.logged_by && <div>by {memberName(e.logged_by)}</div>}`
-- under every entry, so on a replayed database a child could write
--
--   log_type 'medication', note 'Gave Grandma her tablets',
--   logged_by <the PARENT's family_members.id>
--
-- and the care timeline read back "by Dad". The other three are stored-record
-- defects of 0320's class; nothing renders their `logged_by` today.
--
-- Logging stays open to every member on ALL FOUR, deliberately — recording
-- care, a behaviour note, screen time or a taken dose is what the product is
-- for. Only the NAME is pinned.
--
-- Asserts, in both directions:
--
--   1. a child can STILL log, in their own name, on every one of the four —
--      a boundary that stops the honest caller is the wrong boundary;
--   2. a child CANNOT write a care entry attributed to the parent;
--   3. nor a behaviour, screen-time or dose row in the parent's name;
--   4. a PARENT cannot sign for the child either — identity, not role;
--   5. `care_log.logged_by` NULL is STILL ACCEPTED, because care-module writes
--      `selfMember?.id ?? null` and the renderer shows no name for a NULL —
--      an unattributed row is not a misattributed one;
--   6. `care_log.created_by` IS pinned: both insert sites always pass `userId`;
--   7. the attribution is IMMUTABLE — a child cannot re-sign an existing row
--      through a direct UPDATE, on a table with `created_by` and on one
--      without (the trigger's `to_jsonb(new) ? 'created_by'` branch);
--   8. a parent can still EDIT a child's entry, which `openEdit` allows and no
--      role check forbids — the reason UPDATE is a preserving trigger rather
--      than a checking policy;
--   9. reads stay `is_family_member` on all four;
--  10. `anon` holds no INSERT;
--  11. NEGATIVE CONTROL: drop the guards and require the forgery to land again.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-care-entry-names-who-logged-it-check.sql

\set FC '00000000-0000-4000-8000-00000000ca10'
\set UP '00000000-0000-4000-8000-00000000ca11'
\set UK '00000000-0000-4000-8000-00000000ca12'
\set MP '00000000-0000-4000-8000-00000000ca13'
\set MK '00000000-0000-4000-8000-00000000ca14'

begin;

insert into auth.users (id, email) values (:'UP','ca-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','ca-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FC','Care Ledger House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FC',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FC' and user_id = :'UP';
-- The owner row `handle_new_family` created gets our fixed id, so the probe can
-- name it without guessing.
update public.family_members set id = :'MP' where family_id = :'FC' and user_id = :'UP';

-- A genuine parent-written entry, exactly as care-module's quickLog writes one.
insert into public.care_log (id, family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
  values ('00000000-0000-4000-8000-00000000ca15', :'FC', :'MK', 'medication', now(),
          'Morning tablets', :'MP', :'UP');
insert into public.behavior_logs (id, family_id, member_id, kind, category, note, points, occurred_at, logged_by)
  values ('00000000-0000-4000-8000-00000000ca16', :'FC', :'MK', 'positive', 'general', 'Tidied up', 5, now(), :'UP');

grant select, insert, update, delete on
  public.care_log, public.behavior_logs, public.screen_time_entries, public.medication_doses
  to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-00000000ca10';
  parent_u constant uuid := '00000000-0000-4000-8000-00000000ca11';
  kid_u    constant uuid := '00000000-0000-4000-8000-00000000ca12';
  parent_m constant uuid := '00000000-0000-4000-8000-00000000ca13';
  kid_m    constant uuid := '00000000-0000-4000-8000-00000000ca14';
  genuine  constant uuid := '00000000-0000-4000-8000-00000000ca15';
  beh_row  constant uuid := '00000000-0000-4000-8000-00000000ca16';
  med_id   uuid;
  sch_id   uuid;
  rendered text;
begin
  -- A medication and a schedule for the dose half, written before the role
  -- switch so the probe is testing the dose policy and not this setup.
  insert into public.medications (id, family_id, member_id, name, is_active)
    values (gen_random_uuid(), fam, kid_m, 'Probe Tablets', true) returning id into med_id;
  insert into public.medication_schedules (id, family_id, medication_id, time_of_day)
    values (gen_random_uuid(), fam, med_id, time '08:00') returning id into sch_id;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. The honest caller, on all four. This is the designed member action.
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'note', now(), 'Felt better today', kid_m, kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer log care IN THEIR OWN NAME — logging is the feature and this broke it');
  end;
  begin
    insert into public.behavior_logs (family_id, member_id, kind, category, note, points, occurred_at, logged_by)
      values (fam, kid_m, 'neutral', 'general', 'Read a book', 0, now(), kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer log a behaviour note about themselves');
  end;
  begin
    insert into public.screen_time_entries (family_id, member_id, entry_date, minutes, category, logged_by)
      values (fam, kid_m, current_date, 30, 'gaming', kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer log their own screen time');
  end;
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
      values (fam, med_id, sch_id, kid_m, now(), 'taken', now(), kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer mark their OWN dose taken — the single most ordinary action on this surface');
  end;

  -- 2. The forgery that reaches a screen.
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'medication', now(), 'Gave Grandma her tablets', parent_m, kid_u);
    failures := array_append(failures, 'a child wrote a care entry attributed to the PARENT — the care timeline renders it as "by <parent>"');
  exception when insufficient_privilege then null;
  end;

  -- 3. The three stored-record siblings.
  begin
    insert into public.behavior_logs (family_id, member_id, kind, category, note, points, occurred_at, logged_by)
      values (fam, kid_m, 'positive', 'general', 'Was an angel', 99, now(), parent_u);
    failures := array_append(failures, 'a child wrote a behaviour note signed as the parent');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.screen_time_entries (family_id, member_id, entry_date, minutes, category, logged_by)
      values (fam, kid_m, current_date, 5, 'educational', parent_u);
    failures := array_append(failures, 'a child wrote a screen-time entry signed as the parent');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
      values (fam, med_id, sch_id, kid_m, now() + interval '1 day', 'taken', now(), parent_u);
    failures := array_append(failures, 'a child recorded a dose as given BY THE PARENT — in a medication ledger');
  exception when insufficient_privilege then null;
  end;

  -- 4. Identity, not role: a parent may not sign for the child.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'note', now(), 'blamed on the child', kid_m, parent_u);
    failures := array_append(failures, 'a PARENT wrote a care entry in the child''s name — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;

  -- The parent's own entry still works (positive control for the fix).
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'check_in', now(), 'All well', parent_m, parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not log care in their own name');
  end;

  -- 5. NULL stays accepted on care_log: `selfMember?.id ?? null` produces it,
  --    and the renderer shows no name for a NULL rather than the wrong one.
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'note', now(), 'Written before selfMember resolved', null, parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures,
      'care_log refused a NULL logged_by — care-module writes `selfMember?.id ?? null`, so this refuses a legitimate entry');
  end;

  -- 6. created_by IS pinned: both insert sites always pass userId.
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'note', now(), 'authored by someone else', kid_m, parent_u);
    failures := array_append(failures, 'a child set care_log.created_by to the parent''s uid');
  exception when insufficient_privilege then null;
  end;

  -- 7. Immutable after insert — the direct UPDATE the app never performs.
  --    Once with a created_by column and once without, because the trigger
  --    branches on `to_jsonb(new) ? 'created_by'`.
  update public.care_log set logged_by = kid_m, note = 'edited' where id = genuine;
  select count(*) into n from public.care_log where id = genuine and logged_by = parent_m;
  if n <> 1 then
    failures := array_append(failures, 'a child RE-SIGNED an existing care entry through a direct UPDATE — the attribution is not immutable');
  end if;
  select count(*) into n from public.care_log where id = genuine and created_by = parent_u;
  if n <> 1 then
    failures := array_append(failures, 'a child rewrote care_log.created_by through a direct UPDATE');
  end if;

  update public.behavior_logs set logged_by = kid_u, note = 'edited' where id = beh_row;
  select count(*) into n from public.behavior_logs where id = beh_row and logged_by = parent_u;
  if n <> 1 then
    failures := array_append(failures,
      'a child re-signed a behaviour note through a direct UPDATE — the trigger''s no-created_by branch does not preserve logged_by');
  end if;

  -- 8. A parent may still EDIT a child's entry. This is why UPDATE is a
  --    preserving trigger and not a checking policy: a policy pinning
  --    logged_by = auth.uid() would evaluate the EXISTING value and refuse.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    update public.care_log set note = 'parent corrected the note'
     where family_id = fam and logged_by = kid_m and note = 'Felt better today';
    get diagnostics n = row_count;
    if n = 0 then
      failures := array_append(failures, 'a PARENT could not edit a child''s care entry — openEdit allows it and no role check forbids it');
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT was refused an edit of a child''s care entry — this guard broke a legitimate path');
  end;

  -- 9. Reads stay open to the household on all four.
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  select count(*) into n from public.care_log where id = genuine;
  if n = 0 then failures := array_append(failures, 'a child can no longer READ the care timeline'); end if;
  select count(*) into n from public.behavior_logs where id = beh_row;
  if n = 0 then failures := array_append(failures, 'a child can no longer READ the behaviour log'); end if;

  -- 10. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.care_log', 'INSERT')
     or has_table_privilege('anon', 'public.behavior_logs', 'INSERT')
     or has_table_privilege('anon', 'public.screen_time_entries', 'INSERT')
     or has_table_privilege('anon', 'public.medication_doses', 'INSERT') then
    failures := array_append(failures, 'anon still holds INSERT on one of the four ledgers');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ────────────────
  drop policy if exists care_log_attribution_guard on public.care_log;
  drop trigger if exists care_log_attribution_immutable on public.care_log;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.care_log (family_id, member_id, log_type, occurred_at, note, logged_by, created_by)
      values (fam, kid_m, 'medication', now(), 'Gave Grandma her tablets', parent_m, kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'with the guard removed the child STILL could not sign as the parent — this probe is decoration, not a boundary');
  end;
  update public.care_log set logged_by = kid_m where id = genuine;

  perform set_config('role','postgres', true);
  -- The exact join care-module.tsx:253 performs.
  select 'by ' || m.display_name into rendered
    from public.care_log c join public.family_members m on m.id = c.logged_by
   where c.family_id = fam and c.note = 'Gave Grandma her tablets';
  if rendered is null or rendered <> 'by ' || (select display_name from public.family_members where id = parent_m) then
    failures := array_append(failures, 'with the guard removed no forged row rendered under the parent''s name — this probe has never been shown to fail');
  end if;
  select count(*) into n from public.care_log where id = genuine and logged_by = kid_m;
  if n <> 1 then
    failures := array_append(failures, 'with the trigger removed the re-signing UPDATE still did not land — the immutability half has never been shown to fail');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a household ledger entry does not say who logged it:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-care-entry-names-who-logged-it: OK (every member still logs in their own name on all four ledgers, nobody signs for anyone else, care_log still accepts a NULL logged_by, attribution is immutable after insert on tables with and without created_by, a parent can still edit a child''s entry, reads unchanged, anon holds no INSERT, negative control rendered the forgery as "by <parent>")';
end $$;

rollback;
