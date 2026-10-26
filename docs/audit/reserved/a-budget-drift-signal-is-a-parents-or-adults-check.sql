-- ── A budget-drift signal is a parent's or another adult's (0528) ────────────
--
-- OPSD-O05: family_signals (01420) is any member's to read and write, and a
-- budget-drift signal (0157) carries the household's spend and limit. The app
-- keeps it a parent's or adult's (readsHouseholdMoney); the held 0528 puts the
-- rule on the table: a RESTRICTIVE read and a write guard.
--
-- Fixture, Signal House: a parent, an adult, a teen, a child and a caregiver;
-- two budget drifts (one naming the child's member row) and an ignored-reminder
-- signal naming the child.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as the teen, the child and the caregiver: reading the drifts returns no
--      row; dismissing them by id matches none (OK 0) or is refused; an
--      unfiltered dismiss, an unfiltered delete, a planted drift and turning
--      the reminder signal into a drift are each refused by 0528's guard
--      (42501, its own sentence);
--   2. control: the parent and the adult each read both drifts, dismiss one,
--      plant one and delete one; the teen, the child and the caregiver each
--      still read the reminder signal, dismiss it, add a reminder signal and
--      refresh it by upsert (the member-reach detection); the server
--      (service_role, no user) files and deletes a drift; the child's member
--      row removed in the child's session empties member_id on the drift that
--      named them; the household deleted in the parent's session takes its
--      signals with it, and so does a deletion in a session that is not its
--      parent's (the order Postgres runs the cascades in is not fixed, so its
--      members may be gone first);
--   3. wiring: the read rule as written, and the guard enabled, FOR EACH ROW,
--      BEFORE INSERT, UPDATE and DELETE, SECURITY DEFINER;
--
-- and, only where 0528 is installed:
--
--   N1. NEGATIVE CONTROL: with the read rule dropped and the guard disabled,
--       the child reads the drifts and the unfiltered dismiss and the planted
--       drift land: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the guard off DELETE, the child's unfiltered
--       delete lands, so 1. catches the delete half going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0528: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/budget-drift-signal-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0528 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8528-0000000000a1','c0528-parent@example.com'),
  ('00000000-0000-4000-8528-0000000000a2','c0528-adult@example.com'),
  ('00000000-0000-4000-8528-0000000000a3','c0528-teen@example.com'),
  ('00000000-0000-4000-8528-0000000000a4','c0528-child@example.com'),
  ('00000000-0000-4000-8528-0000000000a5','c0528-caregiver@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8528-0000000000f1','Signal House','00000000-0000-4000-8528-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8528-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8528-0000000000d2','00000000-0000-4000-8528-0000000000f1','00000000-0000-4000-8528-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8528-0000000000d3','00000000-0000-4000-8528-0000000000f1','00000000-0000-4000-8528-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8528-0000000000d4','00000000-0000-4000-8528-0000000000f1','00000000-0000-4000-8528-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8528-0000000000d5','00000000-0000-4000-8528-0000000000f1','00000000-0000-4000-8528-0000000000a5','Caregiver','caregiver',true);
insert into public.family_signals (id, family_id, kind, subject_key, title, detail, score, evidence, member_id) values
  ('00000000-0000-4000-8528-0000000000b1','00000000-0000-4000-8528-0000000000f1','budget_drift','budget:groceries','Groceries are over','Spent 640 of 500',80,'{"spent":640,"limit":500}',null),
  ('00000000-0000-4000-8528-0000000000b2','00000000-0000-4000-8528-0000000000f1','ignored_reminder','reminder:piano','Piano practice keeps slipping',null,40,'{}','00000000-0000-4000-8528-0000000000d4'),
  ('00000000-0000-4000-8528-0000000000b3','00000000-0000-4000-8528-0000000000f1','budget_drift','budget:kit-allowance','Kit''s allowance is over','Spent 30 of 20',60,'{"spent":30,"limit":20}','00000000-0000-4000-8528-0000000000d4');

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0528_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- The same, undone afterwards, so no attempt changes what the next one sees.
create or replace function pg_temp.c0528_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0528_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

-- What a teen, a child or a caregiver may not do, what 0528 answers (a list of
-- acceptable results), and the statement.
create temp table c0528_refused (what text, answers text[], stmt text) on commit drop;
insert into c0528_refused values
  ('read the budget drifts', array['OK 0'],
   'select id, title, evidence from public.family_signals where kind = ''budget_drift'''),
  ('dismissed the groceries drift by id', array['OK 0', 'guard'],
   'update public.family_signals set status = ''dismissed'' where id = ''00000000-0000-4000-8528-0000000000b1'''),
  ('dismissed every signal, unfiltered', array['guard'],
   'update public.family_signals set status = ''dismissed'''),
  ('deleted every signal, unfiltered', array['guard'],
   'delete from public.family_signals'),
  ('planted a budget drift', array['guard'],
   'insert into public.family_signals (family_id, kind, subject_key, title, score) values (''00000000-0000-4000-8528-0000000000f1'', ''budget_drift'', ''budget:fun'', ''All fine'', 1)'),
  ('turned the reminder signal into a budget drift', array['guard'],
   'update public.family_signals set kind = ''budget_drift'' where id = ''00000000-0000-4000-8528-0000000000b2''');

do $$
declare
  guard constant text := '42501: A budget drift signal is the household''s money, a parent''s or another adult''s';
  parent constant text := '00000000-0000-4000-8528-0000000000a1';
  child constant text := '00000000-0000-4000-8528-0000000000a4';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  m record;
  r record;
  got text;
  n bigint;
begin
  installed := exists (select 1 from pg_trigger g
                        where g.tgfoid = to_regprocedure('public.a_budget_drift_signal_is_written_by_a_parent_or_adult()'));

  -- 1. What the teen, the child and the caregiver may not do.
  for m in select * from (values ('teen', '00000000-0000-4000-8528-0000000000a3'),
                                 ('child', '00000000-0000-4000-8528-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8528-0000000000a5')) v(role, uid) loop
    for r in select * from c0528_refused loop
      got := pg_temp.c0528_try('authenticated', m.uid, r.stmt);
      if got = any (r.answers) or ('guard' = any (r.answers) and got = guard) then
        continue;
      end if;
      if got like 'OK%' then
        failures := array_append(failures, format('the %s %s (%s)', m.role, r.what, got));
      else
        failures := array_append(failures, format('the %s was refused when they %s, but not by 0528''s guard (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;

  -- 2. Controls.
  bad := '{}';
  for m in select * from (values ('parent', '00000000-0000-4000-8528-0000000000a1'),
                                 ('adult', '00000000-0000-4000-8528-0000000000a2')) v(role, uid) loop
    for r in select * from (values
        ('read both drifts', 'select id from public.family_signals where kind = ''budget_drift''', 'OK 2'),
        ('dismiss the groceries drift', 'update public.family_signals set status = ''dismissed'' where id = ''00000000-0000-4000-8528-0000000000b1''', 'OK 1'),
        ('plant a drift', 'insert into public.family_signals (family_id, kind, subject_key, title, score) values (''00000000-0000-4000-8528-0000000000f1'', ''budget_drift'', ''budget:fun'', ''Fun is over'', 50)', 'OK 1'),
        ('delete the groceries drift', 'delete from public.family_signals where id = ''00000000-0000-4000-8528-0000000000b1''', 'OK 1')) v(what, stmt, want) loop
      got := pg_temp.c0528_try('authenticated', m.uid, r.stmt);
      if got <> r.want then
        bad := array_append(bad, format('the %s could not %s (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  for m in select * from (values ('teen', '00000000-0000-4000-8528-0000000000a3'),
                                 ('child', '00000000-0000-4000-8528-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8528-0000000000a5')) v(role, uid) loop
    for r in select * from (values
        ('read the reminder signal', 'select id from public.family_signals where kind <> ''budget_drift'''),
        ('dismiss the reminder signal', 'update public.family_signals set status = ''dismissed'' where id = ''00000000-0000-4000-8528-0000000000b2'''),
        ('add a reminder signal', 'insert into public.family_signals (family_id, kind, subject_key, title, score) values (''00000000-0000-4000-8528-0000000000f1'', ''ignored_reminder'', ''reminder:bins'', ''Bins keep slipping'', 30)'),
        ('refresh the reminder signal by upsert', 'insert into public.family_signals (family_id, kind, subject_key, title, score) values (''00000000-0000-4000-8528-0000000000f1'', ''ignored_reminder'', ''reminder:piano'', ''Piano practice keeps slipping'', 45) on conflict (family_id, kind, subject_key) do update set score = excluded.score, last_seen_at = now()')) v(what, stmt) loop
      got := pg_temp.c0528_try('authenticated', m.uid, r.stmt);
      if got <> 'OK 1' then
        bad := array_append(bad, format('the %s could not %s (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  for r in select * from (values
      ('file a drift', 'insert into public.family_signals (family_id, kind, subject_key, title, score) values (''00000000-0000-4000-8528-0000000000f1'', ''budget_drift'', ''budget:travel'', ''Travel is over'', 70)'),
      ('delete a drift', 'delete from public.family_signals where id = ''00000000-0000-4000-8528-0000000000b1''')) v(what, stmt) loop
    got := pg_temp.c0528_try('service_role', '', r.stmt);
    if got <> 'OK 1' then
      bad := array_append(bad, format('the server could not %s (%s)', r.what, got));
    end if;
  end loop;
  -- The child's member row, removed in the child's own session.
  begin
    perform set_config('request.jwt.claim.sub', child, true);
    perform set_config('request.jwt.claims', json_build_object('sub', child, 'role', 'authenticated')::text, true);
    begin
      delete from public.family_members where id = '00000000-0000-4000-8528-0000000000d4';
      if (select member_id from public.family_signals where id = '00000000-0000-4000-8528-0000000000b3') is not null then
        bad := array_append(bad, 'removing the child''s member row left the drift naming them');
      end if;
    exception when others then
      bad := array_append(bad, format('removing the child''s member row in their session failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  -- The household, deleted in the parent's session.
  begin
    perform set_config('request.jwt.claim.sub', parent, true);
    perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
    begin
      delete from public.families where id = '00000000-0000-4000-8528-0000000000f1';
      select count(*) into n from public.family_signals where family_id = '00000000-0000-4000-8528-0000000000f1';
      if n <> 0 then
        bad := array_append(bad, format('deleting the household left %s of its signals', n));
      end if;
    exception when others then
      bad := array_append(bad, format('deleting the household in the parent''s session failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  -- The household, deleted where its parent is no longer its parent by the
  -- time the cascade reaches these rows: Postgres runs the cascades from
  -- families in constraint-trigger-name order, which is not fixed, so
  -- family_members may go first. Forced here, on any cluster, by deleting it in
  -- the child's session.
  begin
    perform set_config('request.jwt.claim.sub', child, true);
    perform set_config('request.jwt.claims', json_build_object('sub', child, 'role', 'authenticated')::text, true);
    begin
      delete from public.families where id = '00000000-0000-4000-8528-0000000000f1';
    exception when others then
      bad := array_append(bad, format('deleting the household in a session that is not its parent''s failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  bad := '{}';
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'family_signals'
                    and policyname = 'A budget drift signal is read by a parent or adult'
                    and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
                    and qual = '((kind <> ''budget_drift''::text) OR can_manage_family(family_id))') then
    bad := array_append(bad, 'the read rule');
  end if;
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.family_signals'::regclass
                    and g.tgname = 'trg_family_signals_budget_drift_parent_or_adult'
                    and g.tgfoid = to_regprocedure('public.a_budget_drift_signal_is_written_by_a_parent_or_adult()')
                    and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28
                    and p.prosecdef) then
    bad := array_append(bad, 'the write guard');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0528 is not in place on family_signals: %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. The read rule dropped and the guard disabled.
    begin
      drop policy "A budget drift signal is read by a parent or adult" on public.family_signals;
      alter table public.family_signals disable trigger trg_family_signals_budget_drift_parent_or_adult;
      bad := '{}';
      for r in select * from c0528_refused where what in ('read the budget drifts', 'dismissed every signal, unfiltered', 'planted a budget drift') loop
        got := pg_temp.c0528_try('authenticated', child, r.stmt);
        if got not in ('OK 1', 'OK 2', 'OK 3') then
          bad := array_append(bad, format('%s (%s)', r.what, got));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: without 0528 the child still was not let through: %s, so this fixture cannot see the defect', array_to_string(bad, '; ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The guard off DELETE.
    begin
      drop trigger trg_family_signals_budget_drift_parent_or_adult on public.family_signals;
      create trigger trg_family_signals_budget_drift_parent_or_adult before insert or update on public.family_signals
        for each row execute function public.a_budget_drift_signal_is_written_by_a_parent_or_adult();
      got := pg_temp.c0528_try('authenticated', child, 'delete from public.family_signals');
      if got not like 'OK%' or got = 'OK 0' then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard off DELETE the child''s unfiltered delete still did not land (%s), so 1. cannot catch the delete half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a budget drift signal is not only a parent''s or adult''s:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-budget-drift-signal-is-a-parents-or-adults: OK (as the teen, the child and the caregiver, the budget drifts read no row, a dismiss by id matched none, and an unfiltered dismiss or delete, a planted drift and a reminder turned drift were refused by 0528''s guard; parents and adults read, dismiss, plant and delete drifts; everyone else still reads, dismisses, adds and refreshes other signals; the server files and deletes; a member''s removal and the household''s deletion still go through; the read rule and the guard are in place; negative control: without 0528 the child read the drifts, dismissed and planted; mutation control: with the guard off DELETE the child''s delete landed)';
end $$;

rollback;
