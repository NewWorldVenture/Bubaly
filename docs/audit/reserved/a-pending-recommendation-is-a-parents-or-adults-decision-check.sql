-- ── A pending recommendation is a parent's or another adult's decision (0530) ─
--
-- CALHUB-O3: family_ai_recommendations (0022) is FOR ALL is_family_member, and a
-- pending recommendation waits on the parents (Needs You, Home, the briefing).
-- The app writes it only as a parent or adult, or as the server; the held 0530
-- puts that rule on the table.
--
-- Fixture, Rec House: a parent, an adult, a teen, a child, a caregiver and a
-- guest (is_family_member admits every active member, the guest too); two
-- pending recommendations, one naming the child's member row.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as the teen, the child, the caregiver and the guest, each refused by
--      0530's guard
--      (42501, its own sentence): dismissing a pending recommendation by id, an
--      unfiltered dismiss, deleting one, and planting a pending card;
--   2. control: the parent and the adult each dismiss, accept, delete and file
--      one; the teen, the child and the caregiver still read them; the server
--      (service_role, no user) files one; the child's member row removed in the
--      child's own session empties member_id on the card naming them; the
--      household deleted in the parent's session takes its cards with it, and
--      so does a deletion in a session that is not its parent's (the order
--      Postgres runs the cascades in is not fixed, so its members may be gone
--      first);
--   3. wiring: the guard, enabled, FOR EACH ROW, BEFORE INSERT, UPDATE and
--      DELETE, SECURITY DEFINER;
--
-- and, only where 0530 is installed:
--
--   N1. NEGATIVE CONTROL: with the guard disabled, the child's dismiss and
--       planted card land: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the guard checking the new row only, the
--       child's delete lands, so 1. catches the delete half going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0530: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/recommendation-decision-runtime.yml runs it there to show
-- the failure, then applies the held migration and requires it to pass. It
-- moves back to docs/audit/ when 0530 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8530-0000000000a1','c0530-parent@example.com'),
  ('00000000-0000-4000-8530-0000000000a2','c0530-adult@example.com'),
  ('00000000-0000-4000-8530-0000000000a3','c0530-teen@example.com'),
  ('00000000-0000-4000-8530-0000000000a4','c0530-child@example.com'),
  ('00000000-0000-4000-8530-0000000000a5','c0530-caregiver@example.com'),
  ('00000000-0000-4000-8530-0000000000a6','c0530-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8530-0000000000f1','Rec House','00000000-0000-4000-8530-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8530-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8530-0000000000d2','00000000-0000-4000-8530-0000000000f1','00000000-0000-4000-8530-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8530-0000000000d3','00000000-0000-4000-8530-0000000000f1','00000000-0000-4000-8530-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8530-0000000000d4','00000000-0000-4000-8530-0000000000f1','00000000-0000-4000-8530-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8530-0000000000d5','00000000-0000-4000-8530-0000000000f1','00000000-0000-4000-8530-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8530-0000000000d6','00000000-0000-4000-8530-0000000000f1','00000000-0000-4000-8530-0000000000a6','Guest','guest',true);
insert into public.family_ai_recommendations (id, family_id, member_id, title, status, priority) values
  ('00000000-0000-4000-8530-0000000000b1','00000000-0000-4000-8530-0000000000f1', null, 'Book the dentist', 'pending', 'high'),
  ('00000000-0000-4000-8530-0000000000b2','00000000-0000-4000-8530-0000000000f1', '00000000-0000-4000-8530-0000000000d4', 'Kit''s reading log is behind', 'pending', 'medium');

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0530_as(p_role text, p_uid text, p_sql text) returns text
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
create or replace function pg_temp.c0530_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0530_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

create temp table c0530_writes (what text, stmt text) on commit drop;
insert into c0530_writes values
  ('dismissed the parents'' pending recommendation',
   'update public.family_ai_recommendations set status = ''dismissed'' where id = ''00000000-0000-4000-8530-0000000000b1'''),
  ('dismissed every recommendation, unfiltered',
   'update public.family_ai_recommendations set status = ''dismissed'''),
  ('deleted the parents'' pending recommendation',
   'delete from public.family_ai_recommendations where id = ''00000000-0000-4000-8530-0000000000b1'''),
  ('planted a pending recommendation',
   'insert into public.family_ai_recommendations (family_id, title, status, priority, cta_href) values (''00000000-0000-4000-8530-0000000000f1'', ''Confirm your account'', ''pending'', ''high'', ''/settings'')');

do $$
declare
  guard constant text := '42501: A recommendation waits on a parent or another adult';
  parent constant text := '00000000-0000-4000-8530-0000000000a1';
  child constant text := '00000000-0000-4000-8530-0000000000a4';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  m record;
  r record;
  got text;
  n bigint;
begin
  installed := exists (select 1 from pg_trigger g
                        where g.tgfoid = to_regprocedure('public.a_recommendation_is_decided_by_a_parent_or_adult()'));

  -- 1. What the teen, the child, the caregiver and the guest may not do.
  for m in select * from (values ('teen', '00000000-0000-4000-8530-0000000000a3'),
                                 ('child', '00000000-0000-4000-8530-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8530-0000000000a5'),
                                 ('guest', '00000000-0000-4000-8530-0000000000a6')) v(role, uid) loop
    for r in select * from c0530_writes loop
      got := pg_temp.c0530_try('authenticated', m.uid, r.stmt);
      if got like 'OK%' then
        failures := array_append(failures, format('the %s %s (%s)', m.role, r.what, got));
      elsif got is distinct from guard then
        failures := array_append(failures, format('the %s was refused when they %s, but not by 0530''s guard (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;

  -- 2. Controls.
  bad := '{}';
  for m in select * from (values ('parent', '00000000-0000-4000-8530-0000000000a1'),
                                 ('adult', '00000000-0000-4000-8530-0000000000a2')) v(role, uid) loop
    for r in select * from (values
        ('dismiss a recommendation', 'update public.family_ai_recommendations set status = ''dismissed'' where id = ''00000000-0000-4000-8530-0000000000b1'''),
        ('accept a recommendation', 'update public.family_ai_recommendations set status = ''accepted'' where id = ''00000000-0000-4000-8530-0000000000b1'''),
        ('delete a recommendation', 'delete from public.family_ai_recommendations where id = ''00000000-0000-4000-8530-0000000000b1'''),
        ('file a recommendation', 'insert into public.family_ai_recommendations (family_id, title, status, priority) values (''00000000-0000-4000-8530-0000000000f1'', ''Plan the weekend'', ''pending'', ''medium'')')) v(what, stmt) loop
      got := pg_temp.c0530_try('authenticated', m.uid, r.stmt);
      if got <> 'OK 1' then
        bad := array_append(bad, format('the %s could not %s (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  for m in select * from (values ('teen', '00000000-0000-4000-8530-0000000000a3'),
                                 ('child', '00000000-0000-4000-8530-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8530-0000000000a5')) v(role, uid) loop
    got := pg_temp.c0530_try('authenticated', m.uid, 'select id from public.family_ai_recommendations');
    if got <> 'OK 2' then
      bad := array_append(bad, format('the %s could not read the recommendations (%s)', m.role, got));
    end if;
  end loop;
  got := pg_temp.c0530_try('service_role', '',
    'insert into public.family_ai_recommendations (family_id, title, status, priority, source) values (''00000000-0000-4000-8530-0000000000f1'', ''A recommendation from Bubaly'', ''pending'', ''medium'', ''concierge'')');
  if got <> 'OK 1' then
    bad := array_append(bad, format('the server could not file a recommendation (%s)', got));
  end if;
  -- The child's member row, removed in the child's own session.
  begin
    perform set_config('request.jwt.claim.sub', child, true);
    perform set_config('request.jwt.claims', json_build_object('sub', child, 'role', 'authenticated')::text, true);
    begin
      delete from public.family_members where id = '00000000-0000-4000-8530-0000000000d4';
      if (select member_id from public.family_ai_recommendations where id = '00000000-0000-4000-8530-0000000000b2') is not null then
        bad := array_append(bad, 'removing the child''s member row left the card naming them');
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
      delete from public.families where id = '00000000-0000-4000-8530-0000000000f1';
      select count(*) into n from public.family_ai_recommendations where family_id = '00000000-0000-4000-8530-0000000000f1';
      if n <> 0 then
        bad := array_append(bad, format('deleting the household left %s of its recommendations', n));
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
      delete from public.families where id = '00000000-0000-4000-8530-0000000000f1';
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
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.family_ai_recommendations'::regclass
                    and g.tgname = 'trg_family_ai_recommendations_parent_or_adult'
                    and g.tgfoid = to_regprocedure('public.a_recommendation_is_decided_by_a_parent_or_adult()')
                    and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28
                    and p.prosecdef) then
    failures := array_append(failures, '0530''s guard is not in place on family_ai_recommendations');
  end if;

  if installed then
    -- N1. The guard disabled.
    begin
      alter table public.family_ai_recommendations disable trigger trg_family_ai_recommendations_parent_or_adult;
      bad := '{}';
      for r in select * from c0530_writes where what in ('dismissed the parents'' pending recommendation', 'planted a pending recommendation') loop
        got := pg_temp.c0530_try('authenticated', child, r.stmt);
        if got <> 'OK 1' then
          bad := array_append(bad, format('%s (%s)', r.what, got));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the child still was not let through: %s, so this fixture cannot see the defect', array_to_string(bad, '; ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The guard checking the new row only.
    begin
      create or replace function public.a_recommendation_is_decided_by_a_parent_or_adult()
      returns trigger language plpgsql security definer set search_path = public, pg_temp as $m$
      begin
        if auth.uid() is null then return case when tg_op = 'DELETE' then old else new end; end if;
        if tg_op <> 'DELETE' and not public.can_manage_family(new.family_id) then
          raise exception 'A recommendation waits on a parent or another adult' using errcode = '42501';
        end if;
        return case when tg_op = 'DELETE' then old else new end;
      end $m$;
      got := pg_temp.c0530_try('authenticated', child,
        'delete from public.family_ai_recommendations where id = ''00000000-0000-4000-8530-0000000000b1''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard checking the new row only the child''s delete still did not land (%s), so 1. cannot catch the delete half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a pending recommendation is not only a parent''s or adult''s decision:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-pending-recommendation-is-a-parents-or-adults-decision: OK (as the teen, the child, the caregiver and the guest, dismissing a pending recommendation by id or unfiltered, deleting one and planting one were each refused by 0530''s guard; parents and adults dismiss, accept, delete and file them; the teen, the child and the caregiver still read them; the server files them; a member''s removal in their own session and the household''s deletion still go through; the guard is in place; negative control: with it disabled the child''s dismiss and planted card landed; mutation control: with the guard checking the new row only the child''s delete landed)';
end $$;

rollback;
