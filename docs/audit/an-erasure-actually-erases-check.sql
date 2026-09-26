-- ── An erasure actually erases (0340 / AUTHZ-023) ────────────────────────────
--
-- 0338 froze the attribution columns on four household ledgers with a BEFORE
-- UPDATE trigger that preserves: `new.logged_by := old.logged_by` and the same
-- for `created_by` where the row carries it. Correct for an application UPDATE.
--
-- Five of those columns are `ON DELETE SET NULL`, and Postgres performs a
-- referential action as an ordinary UPDATE — so the trigger fires on it and,
-- unguarded, puts the deleted id straight back. 0340 guards the preserve on
-- `pg_trigger_depth() = 1`, which is an application UPDATE; a referential
-- action arrives at depth 2.
--
-- WHAT THIS PROBE CAN AND CANNOT SEE. The defect has two faces, and which one
-- appears depends on the TRANSACTION MODE, not on the schema (measured by
-- holding schema, constraint and trigger fixed and adding nothing but `begin`):
--
--   autocommit            the revert is silent and a DANGLING REFERENCE COMMITS
--   inside a transaction  RI_FKey_check_upd fires and the DELETE is REFUSED
--
-- This file runs inside a transaction it rolls back, like every probe here, so
-- it sees the second face. That is stated rather than glossed because the first
-- face is the one PRODUCTION gets: `admin.auth.admin.deleteUser` issues a single
-- DELETE in its own transaction. A probe that silently reported the error shape
-- would be describing its own harness.
--
-- Either way the guard is the same, and the negative control below demonstrates
-- the break rather than asserting it.

begin;

do $$
declare
  failures text[] := '{}';
  fn_def   text;
  fam      uuid := '00000000-0000-4000-8000-0000000000f1';
  u_keep   uuid := 'd0000000-0000-4000-8000-0000000000a1';
  u_doomed uuid := 'd0000000-0000-4000-8000-0000000000a2';
  m_keep   uuid := 'd0000000-0000-4000-8000-0000000000b1';
  m_subj   uuid := 'd0000000-0000-4000-8000-0000000000b2';
  ev       uuid := 'd0000000-0000-4000-8000-0000000000c1';
  v        uuid;
  offenders text;
begin
  if to_regclass('public.care_log') is null then
    raise notice 'an-erasure-actually-erases: SKIPPED (care_log absent)';
    return;
  end if;

  fn_def := pg_get_functiondef('public.attribution_is_immutable()'::regprocedure);

  -- 1. The guard exists at all.
  if fn_def not like '%pg_trigger_depth()%' then
    failures := array_append(failures,
      'attribution_is_immutable() has no pg_trigger_depth guard — an account erasure reverts ON DELETE SET NULL');
  end if;

  -- 2. AUTHZ-022: each column preserved only if the row carries it, so the
  --    function is safe on any table rather than only one carrying both.
  if fn_def not like '%to_jsonb(new) ? ''created_by''%' then
    failures := array_append(failures, 'the created_by presence test is gone');
  end if;
  -- BOTH, by name. The first draft of 0340 asserted only created_by, left
  -- logged_by unconditional, and shipped a comment claiming both were tested.
  -- An assertion that checks one of a pair is how that survives review.
  if fn_def not like '%to_jsonb(new) ? ''logged_by''%' then
    failures := array_append(failures,
      'logged_by has no presence test — AUTHZ-022 is open, and the function''s own comment claims otherwise');
  end if;

  -- 3. The depth test is exact only while nothing issues a NESTED update against
  --    these tables. Asked of the catalog, because a trigger added later makes
  --    the freeze stop guarding rows written through it, silently.
  --    p.prosrc, NOT pg_get_functiondef(p.oid): the column read cannot raise,
  --    while pg_get_functiondef() throws on an aggregate's oid. The join should
  --    keep aggregates out, but a filter on a joined relation is not ordered and
  --    the planner may evaluate it while scanning pg_proc. That is not
  --    hypothetical — the first version of this query passed locally and failed
  --    in CI with '"array_agg" is an aggregate function'.
  select string_agg(distinct p.proname || ' on ' || tg.tgrelid::regclass::text, ', ')
    into offenders
    from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
   where not tg.tgisinternal
     and p.prokind = 'f'
     -- COMMENTS ARE STRIPPED BEFORE MATCHING. Measured: a trigger function whose
     -- body is nothing but `-- never update care_log from here` made this
     -- migration exit 3 and the probe exit 3, with an error sending the reader
     -- to hunt a nested UPDATE that does not exist. CI replays every migration,
     -- so one unrelated code comment anywhere in the schema turned the Database
     -- job red.
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
           ~* 'update\s+(public\.)?(care_log|behavior_logs|screen_time_entries|medication_doses)\M';
  if offenders is not null then
    failures := array_append(failures,
      'a trigger now issues a nested UPDATE against a guarded ledger (' || offenders || '), so depth = 1 no longer covers every application write');
  end if;

  -- ── fixtures ───────────────────────────────────────────────────────────────
  -- TWO managers, deliberately: family_keeps_a_manager() refuses to delete the
  -- last active parent, and a control refused by THAT guard would prove nothing
  -- about this one. (Measured: the first run of this scenario was refused for
  -- exactly that reason.)
  insert into auth.users (id, email) values
    (u_keep,   'erasure-keep@example.test'),
    (u_doomed, 'erasure-doomed@example.test') on conflict do nothing;
  insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
    (m_keep, fam, u_keep,   'Erasure Keeper', 'parent', true),
    (m_subj, fam, null,     'Erasure Subject','child',  true) on conflict do nothing;

  -- The entry is ABOUT the child and AUTHORED by the doomed parent. That split
  -- matters: an entry about the doomed member is CASCADE-deleted through
  -- member_id before created_by can matter, so it would test nothing.
  insert into public.care_log (id, family_id, member_id, logged_by, created_by)
    values (ev, fam, m_subj, m_subj, u_doomed);

  -- 4. The freeze 0338 shipped must still hold against an application UPDATE.
  update public.care_log set created_by = u_keep where id = ev;
  select created_by into v from public.care_log where id = ev;
  if v is distinct from u_doomed then
    failures := array_append(failures,
      'an application UPDATE rewrote created_by — 0338''s freeze is gone, not merely depth-guarded');
  end if;

  -- 5. THE FIX: the referential action must get through.
  begin
    delete from auth.users where id = u_doomed;
    -- The row must still be THERE. `select … into` over zero rows leaves v
    -- NULL, so without this the assertion below also passes when the row was
    -- deleted rather than nulled — a probe agreeing with an empty table.
    if not exists (select 1 from public.care_log where id = ev) then
      failures := array_append(failures,
        'the care_log fixture row vanished instead of being SET NULL, so this assertion proves nothing');
    end if;
    select created_by into v from public.care_log where id = ev;
    if v is not null then
      failures := array_append(failures,
        'the account was erased and care_log.created_by STILL names it — a dangling reference survived the deletion');
    end if;
  exception when foreign_key_violation then
    failures := array_append(failures,
      'erasing an account was REFUSED by care_log_created_by_fkey — the preserve reverted the SET NULL (in autocommit this same defect instead commits a dangling reference silently)');
  end;

  -- ── 5b. THE OTHER FOUR SET NULL COLUMNS ────────────────────────────────────
  -- 5 above exercises care_log.created_by only. Four more columns declare the
  -- same referential action and carry the same trigger, and a regression that
  -- reverted ONLY those would have passed this file with exit 0:
  --
  --   behavior_logs.logged_by        -> auth.users
  --   screen_time_entries.logged_by  -> auth.users
  --   medication_doses.logged_by     -> auth.users
  --   care_log.logged_by             -> family_members   (a MEMBER, not a user)
  --
  -- Each is driven end to end rather than asserted from the catalog.
  declare
    u_doom2 uuid := 'd0000000-0000-4000-8000-0000000000a3';
    m_doom  uuid := 'd0000000-0000-4000-8000-0000000000b3';
    med     uuid := 'd0000000-0000-4000-8000-0000000000e1';
    b_row   uuid := 'd0000000-0000-4000-8000-0000000000c2';
    s_row   uuid := 'd0000000-0000-4000-8000-0000000000c3';
    m_row   uuid := 'd0000000-0000-4000-8000-0000000000c4';
    c_row   uuid := 'd0000000-0000-4000-8000-0000000000c5';
    left_over text;
  begin
    insert into auth.users (id, email) values (u_doom2, 'erasure-doomed-2@example.test')
      on conflict do nothing;
    -- a SECOND doomed member, so care_log.logged_by -> family_members can be
    -- tested by deleting the MEMBER rather than the user.
    insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
      values (m_doom, fam, null, 'Erasure Member', 'child', true) on conflict do nothing;
    insert into public.medications (id, family_id, name)
      values (med, fam, 'Erasure Probe Tablet') on conflict do nothing;

    insert into public.behavior_logs (id, family_id, logged_by) values (b_row, fam, u_doom2);
    insert into public.screen_time_entries (id, family_id, logged_by) values (s_row, fam, u_doom2);
    insert into public.medication_doses (id, family_id, medication_id, scheduled_for, logged_by)
      values (m_row, fam, med, now(), u_doom2);
    -- logged_by here references family_members, so it is the MEMBER that is erased.
    insert into public.care_log (id, family_id, member_id, logged_by, created_by)
      values (c_row, fam, m_subj, m_doom, null);

    -- the freeze must still refuse an application rewrite on each of them
    update public.behavior_logs       set logged_by = u_keep where id = b_row;
    update public.screen_time_entries set logged_by = u_keep where id = s_row;
    update public.medication_doses    set logged_by = u_keep where id = m_row;
    update public.care_log            set logged_by = m_keep where id = c_row;
    select string_agg(t, ', ') into left_over from (
      select 'behavior_logs'       as t where (select logged_by from public.behavior_logs       where id = b_row) is distinct from u_doom2
      union all
      select 'screen_time_entries'      where (select logged_by from public.screen_time_entries where id = s_row) is distinct from u_doom2
      union all
      select 'medication_doses'         where (select logged_by from public.medication_doses    where id = m_row) is distinct from u_doom2
      union all
      select 'care_log.logged_by'       where (select logged_by from public.care_log            where id = c_row) is distinct from m_doom
    ) q;
    if left_over is not null then
      failures := array_append(failures,
        'an application UPDATE rewrote the attribution on: ' || left_over || ' — the freeze does not cover every guarded column');
    end if;

    -- and the referential action must get through on each of them
    delete from auth.users where id = u_doom2;
    delete from public.family_members where id = m_doom;
    select string_agg(t, ', ') into left_over from (
      select 'behavior_logs'       as t where exists (select 1 from public.behavior_logs       where id = b_row and logged_by is not null)
      union all
      select 'screen_time_entries'      where exists (select 1 from public.screen_time_entries where id = s_row and logged_by is not null)
      union all
      select 'medication_doses'         where exists (select 1 from public.medication_doses    where id = m_row and logged_by is not null)
      union all
      select 'care_log.logged_by'       where exists (select 1 from public.care_log            where id = c_row and logged_by is not null)
    ) q;
    if left_over is not null then
      failures := array_append(failures,
        'erasure left a dangling attribution on: ' || left_over || ' — the depth guard does not reach every guarded column');
    end if;
  exception when foreign_key_violation then
    failures := array_append(failures,
      'erasing an account or member was REFUSED on one of the four secondary columns — the preserve reverted its SET NULL (in autocommit the same defect instead commits a dangling reference silently)');
  end;

  -- ── 6. NEGATIVE CONTROL ────────────────────────────────────────────────────
  -- Put the defect back inside this transaction and require the probe to see it.
  -- The re-stamp happens with the trigger OFF, because the very preserve under
  -- test would otherwise freeze it — itself a reminder that after 0338 no
  -- application path can correct a wrong attribution.
  create or replace function public.attribution_is_immutable()
  returns trigger language plpgsql as $fn$
  begin
    new.logged_by := old.logged_by;
    if to_jsonb(new) ? 'created_by' then new.created_by := old.created_by; end if;
    return new;
  end $fn$;

  alter table public.care_log disable trigger care_log_attribution_immutable;
  insert into auth.users (id, email) values (u_doomed, 'erasure-doomed-again@example.test')
    on conflict do nothing;
  update public.care_log set created_by = u_doomed where id = ev;
  alter table public.care_log enable trigger care_log_attribution_immutable;

  select created_by into v from public.care_log where id = ev;
  if v is distinct from u_doomed then
    failures := array_append(failures,
      'the negative control could not re-stamp the doomed account, so it proves nothing');
  else
    declare
      broke boolean := false;
    begin
      begin
        delete from auth.users where id = u_doomed;
        select created_by into v from public.care_log where id = ev;
        if v is not null then broke := true; end if;   -- silent dangling reference
      exception when foreign_key_violation then
        broke := true;                                  -- refused, the in-transaction face
      end;
      if not broke then
        failures := array_append(failures,
          'with the preserve made unconditional again the erasure STILL cleared created_by — the pg_trigger_depth guard has never been shown to matter, so this probe is decoration');
      end if;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'an erasure does not actually erase:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'an-erasure-actually-erases: OK (0338''s freeze still refuses an application rewrite of the attribution, while the columns'' own ON DELETE SET NULL now fires so erasing an account clears the name instead of leaving it behind; no trigger issues a nested UPDATE that the depth test would misread; negative control put the unconditional preserve back and the erasure broke)';
end $$;

rollback;
