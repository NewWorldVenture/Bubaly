-- Prove sensitive memory text is filtered at the authenticated database
-- boundary, not only in application services. This uses two synthetic families
-- and synthetic users, and rolls every fixture row back at the end.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/family-memory-sensitive-text-check.sql

begin;

do $$
begin
  if to_regclass('public.family_facts') is null
     or to_regclass('public.family_playbook_suggestions') is null then
    raise exception 'memory-sensitive-text SKIP: memory tables are missing';
  end if;
  if public.family_memory_text_is_sensitive('other', 'Meal', 'Taco night', 'Tuesday') then
    raise exception 'memory-sensitive-text FAIL: benign family text was classified as sensitive';
  end if;
  if not public.family_memory_text_is_sensitive('other', 'Meal', 'Taco night', 'synthetic password marker') then
    raise exception 'memory-sensitive-text FAIL: note-only marker was not classified';
  end if;
  if not public.family_memory_text_is_sensitive('other', 'Meal', 'Taco night', 'synthetic passport number marker') then
    raise exception 'memory-sensitive-text FAIL: evidence-only marker was not classified';
  end if;
end
$$;

insert into auth.users (id, email) values
  ('80000000-0000-4000-8000-000000000011', 'memory-parent@example.invalid'),
  ('80000000-0000-4000-8000-000000000022', 'memory-child@example.invalid'),
  ('80000000-0000-4000-8000-000000000033', 'memory-foreign@example.invalid')
on conflict (id) do nothing;

insert into public.families (id, name, created_by) values
  ('80000000-0000-4000-8000-000000000001', 'Synthetic memory household', '80000000-0000-4000-8000-000000000011'),
  ('80000000-0000-4000-8000-000000000002', 'Synthetic foreign household', '80000000-0000-4000-8000-000000000033');

insert into public.family_members (id, family_id, user_id, role, display_name, is_active) values
  ('80000000-0000-4000-8000-000000000022', '80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000022', 'child', 'Synthetic child', true);

insert into public.family_facts (id, family_id, category, label, value, notes, created_by) values
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'preference', 'Meal', 'Taco night', 'Tuesday dinner', '80000000-0000-4000-8000-000000000011'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', 'medical', 'Care plan', 'Synthetic appointment', 'Synthetic medical marker', '80000000-0000-4000-8000-000000000011'),
  ('81000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', 'other', 'Passport number marker', 'Synthetic value', 'ordinary note', '80000000-0000-4000-8000-000000000011'),
  ('81000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000001', 'other', 'Bank details', 'Synthetic routing marker', 'ordinary note', '80000000-0000-4000-8000-000000000011'),
  ('81000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000001', 'other', 'Door code reminder', 'Leave at noon', 'Synthetic password marker', '80000000-0000-4000-8000-000000000011'),
  ('81000000-0000-4000-8000-000000000006', '80000000-0000-4000-8000-000000000002', 'preference', 'Foreign meal', 'Pasta', 'Synthetic foreign marker', '80000000-0000-4000-8000-000000000033');

insert into public.family_playbook_suggestions (id, family_id, category, label, value, evidence, signature, created_by) values
  ('82000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'preference', 'Meal', 'Taco night', 'Planned three synthetic Tuesdays', 'synthetic:memory-safe', '80000000-0000-4000-8000-000000000011'),
  ('82000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', 'other', 'Meal', 'Taco night', 'Synthetic passport number marker', 'synthetic:memory-evidence', '80000000-0000-4000-8000-000000000011'),
  ('82000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', 'other', 'Account password marker', 'Synthetic value', 'ordinary evidence', 'synthetic:memory-label', '80000000-0000-4000-8000-000000000011'),
  ('82000000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000001', 'other', 'Ordinary suggestion', 'Synthetic routing marker', 'ordinary evidence', 'synthetic:memory-value', '80000000-0000-4000-8000-000000000011'),
  ('82000000-0000-4000-8000-000000000005', '80000000-0000-4000-8000-000000000002', 'preference', 'Foreign idea', 'Pasta', 'Synthetic foreign marker', 'synthetic:memory-foreign', '80000000-0000-4000-8000-000000000033');

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000022', true);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_count integer;
  v_changed integer;
begin
  select count(*) into v_count from public.family_facts
   where family_id = '80000000-0000-4000-8000-000000000001';
  if v_count <> 1 then
    raise exception 'memory-sensitive-text FAIL: child sees % facts; expected only its one benign same-family fact', v_count;
  end if;
  if not exists (select 1 from public.family_facts where id = '81000000-0000-4000-8000-000000000001') then
    raise exception 'memory-sensitive-text FAIL: child cannot read the benign family fact';
  end if;
  if exists (select 1 from public.family_facts where id in (
    '81000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000003',
    '81000000-0000-4000-8000-000000000004',
    '81000000-0000-4000-8000-000000000005',
    '81000000-0000-4000-8000-000000000006'
  )) then
    raise exception 'memory-sensitive-text FAIL: child sees a sensitive or foreign fact';
  end if;

  select count(*) into v_count from public.family_playbook_suggestions
   where family_id = '80000000-0000-4000-8000-000000000001';
  if v_count <> 1 then
    raise exception 'memory-sensitive-text FAIL: child sees % suggestions; expected only its one benign same-family suggestion', v_count;
  end if;
  if not exists (select 1 from public.family_playbook_suggestions where id = '82000000-0000-4000-8000-000000000001') then
    raise exception 'memory-sensitive-text FAIL: child cannot read the benign playbook suggestion';
  end if;
  if exists (select 1 from public.family_playbook_suggestions where id in (
    '82000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000003',
    '82000000-0000-4000-8000-000000000004',
    '82000000-0000-4000-8000-000000000005'
  )) then
    raise exception 'memory-sensitive-text FAIL: child sees a sensitive or foreign suggestion';
  end if;

  -- These are intentionally still member-writable operations on an ordinary
  -- card. The migration is a sensitive SELECT boundary, not a feature lockout.
  insert into public.family_playbook_suggestions
    (family_id, category, label, value, evidence, signature, status, created_by)
  values
    ('80000000-0000-4000-8000-000000000001', 'preference', 'Child idea', 'Pasta night', 'Synthetic ordinary evidence', 'synthetic:child-written-safe-card', 'suggested', auth.uid());
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'memory-sensitive-text FAIL: child cannot create an ordinary playbook suggestion';
  end if;

  update public.family_playbook_suggestions
     set status = 'dismissed'
   where signature = 'synthetic:child-written-safe-card';
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    raise exception 'memory-sensitive-text FAIL: child cannot dismiss its ordinary suggestion';
  end if;
end
$$;

select pg_catalog.set_config('request.jwt.claim.sub', '80000000-0000-4000-8000-000000000011', true);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.family_facts
   where family_id = '80000000-0000-4000-8000-000000000001';
  if v_count <> 5 then
    raise exception 'memory-sensitive-text FAIL: parent sees % facts; expected all five same-family rows', v_count;
  end if;
  select count(*) into v_count from public.family_playbook_suggestions
   where family_id = '80000000-0000-4000-8000-000000000001';
  if v_count <> 5 then
    raise exception 'memory-sensitive-text FAIL: parent sees % suggestions; expected four seeded rows plus the child''s ordinary card', v_count;
  end if;
  if exists (select 1 from public.family_facts where id = '81000000-0000-4000-8000-000000000006')
     or exists (select 1 from public.family_playbook_suggestions where id = '82000000-0000-4000-8000-000000000005') then
    raise exception 'memory-sensitive-text FAIL: manager bypassed tenant isolation';
  end if;
end
$$;

reset role;
rollback;
\echo 'NOTICE: memory-sensitive-text OK — sensitive notes/evidence are hidden from a child through direct authenticated SELECT, ordinary cards stay usable, managers retain access, and foreign rows remain isolated.'
