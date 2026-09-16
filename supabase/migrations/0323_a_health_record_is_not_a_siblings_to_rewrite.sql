-- Bubaly :: 0323 - a health record is not a sibling's to rewrite
-- ----------------------------------------------------------------------------
-- Renumbered from 0307. main landed seven migrations at once — 0304 economy
-- invest decision guard, 0305 chore award amounts, 0306 money instructions,
-- 0307 chore prices, 0308 reward catalogue, 0309 prescriptions, 0310 UI-only
-- manager gates — colliding with this branch's whole 0304-0310 block. The NINTH
-- collision event between the two sessions and by far the largest; every merge
-- since 0300 has brought one. Only the numbers changed: this branch's seven
-- moved together to 0320-0326, keeping their order relative to each other.
--
-- Main's seven are RESTRICTIVE guards (`as restrictive`, 0254's mechanism), so
-- they AND with everything here and nothing in this block can loosen them by
-- running later. The two sets are defence in depth over the same tables rather
-- than one overwriting the other, and the probes are run against the combined
-- chain to say so rather than to assume it.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- Nine health tables still carry the shape 0300 narrowed on `medications`:
--
--   care_log, health_goals, health_metrics, health_visits, immunizations,
--   nutrition_logs, sleep_checkins, sleep_logs, symptom_logs
--
-- — `for all using (is_family_member(family_id))`, so ANY member may rewrite or
-- delete ANY other member's health record. Every one of them is written
-- DIRECTLY FROM THE BROWSER (`createClient()` in health-module, sleep-module,
-- nutrition-view, health-visits-module, immunizations-module, care-module), and
-- not one of those six modules contains a single role check — `grep -n
-- 'isManager\|role ===' ` over all six returns nothing. A child is a real
-- Supabase auth user (child-login-actions.ts creates one), so the browser
-- reaches PostgREST with the anon key and RLS is the ONLY boundary there is.
--
-- What that buys an unhappy sibling today:
--
--   update symptom_logs  set status='resolved'  where member_id=<sister>
--   delete from sleep_logs                      where member_id=<brother>
--   delete from immunizations                   where member_id=<self>
--   update health_visits set notes='…'          where member_id=<anyone>
--
-- TWO DIFFERENT RULES, because these are not one kind of record.
--
-- RULE A — a log you keep about YOURSELF. symptom_logs, health_metrics,
--   health_goals, sleep_logs, sleep_checkins, nutrition_logs. The subject of the
--   row is the point of the row: a teenager logs their own sleep and their own
--   meals, and three of these tables are written with `upsert(...,
--   { onConflict: 'member_id,<date>' })`, so the SECOND entry of the day is an
--   UPDATE. A rule of "author only" would refuse a child correcting their own
--   log the moment a parent had recorded one for them first. So: a manager, the
--   author, OR the member the row is about.
--
-- RULE B — a record of medical FACT, kept about someone. health_visits,
--   immunizations, care_log. Here the subject is exactly who should NOT be able
--   to erase it: a child deleting the record of their own vaccination, or a
--   dependent deleting a caregiver's note about them, is the defect and not the
--   feature. So: a manager or the author, and not the subject.
--
-- INSERT IS DELIBERATELY UNCHANGED ON ALL NINE, still `is_family_member`. 0300
-- filed two OWNER DECISIONS — whether logging a vaccination is any member's to
-- do, and whether health READS should narrow — and neither is answered here.
-- This migration closes only the part that needs no product decision: nobody
-- should be able to rewrite or delete a health record that is neither theirs nor
-- theirs to manage. Reads stay family-wide for the same reason 0300 gave:
-- narrowing them would hide family-wide rows from children, which is a product
-- question, not a security one.
--
-- `health_metrics` is the one table with no `created_by` at all, so it gains
-- one. Existing rows keep NULL, which under Rule A means the subject or a
-- manager may still edit them and a bystander may not — the safe reading of "we
-- do not know who wrote this".

alter table public.health_metrics
  add column if not exists created_by uuid references auth.users(id) on delete set null;

do $$
declare
  spec      record;
  pol       record;
  swept     int := 0;
  remaining int;
  keep      text[];
  owner     text;
begin
  for spec in
    select * from (values
      -- table,           rule
      ('symptom_logs',    'A'),
      ('health_metrics',  'A'),
      ('health_goals',    'A'),
      ('sleep_logs',      'A'),
      ('sleep_checkins',  'A'),
      ('nutrition_logs',  'A'),
      ('health_visits',   'B'),
      ('immunizations',   'B'),
      ('care_log',        'B')
    ) as t(tbl, rule)
  loop
    if to_regclass('public.' || spec.tbl) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', spec.tbl);

    keep := array[
      spec.tbl || '_read',
      spec.tbl || '_member_insert',
      spec.tbl || '_owner_update',
      spec.tbl || '_owner_delete'
    ];

    -- Reads: family-wide, exactly as before. Restated so the sweep below cannot
    -- take a FOR ALL policy's read half away with its write half.
    execute format('drop policy if exists %I on public.%I', spec.tbl || '_read', spec.tbl);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))',
      spec.tbl || '_read', spec.tbl);

    -- INSERT: unchanged. Any member may record. See the header — who may record
    -- a vaccination is an owner decision, filed by 0300 and still filed.
    execute format('drop policy if exists %I on public.%I', spec.tbl || '_member_insert', spec.tbl);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_family_member(family_id))',
      spec.tbl || '_member_insert', spec.tbl);

    -- UPDATE / DELETE: the two rules, spelled out once here.
    --   A adds `is_self_member(member_id)`; B deliberately does not.
    owner := 'public.can_manage_family(family_id) or created_by = auth.uid()'
      || case spec.rule when 'A' then ' or public.is_self_member(member_id)' else '' end;

    execute format('drop policy if exists %I on public.%I', spec.tbl || '_owner_update', spec.tbl);
    execute format(
      'create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
      spec.tbl || '_owner_update', spec.tbl, owner, owner);
    execute format('drop policy if exists %I on public.%I', spec.tbl || '_owner_delete', spec.tbl);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (%s)',
      spec.tbl || '_owner_delete', spec.tbl, owner);

    -- Sweep stray permissive WRITE policies BY SHAPE, not by name — 0217
    -- narrowed five wallet tables by name and left six behind, which is how
    -- 0325 came to exist. `*` (FOR ALL) is included: that is the shape being
    -- replaced here, and its read half has been restated above.
    for pol in
      select p.polname from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = spec.tbl
        and p.polpermissive and p.polcmd in ('a','w','d','*')
        and not (p.polname = any(keep))
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, spec.tbl);
      swept := swept + 1;
      raise notice '0323: dropped stray permissive write policy %.%', spec.tbl, pol.polname;
    end loop;

    select count(*) into remaining
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = spec.tbl
      and p.polpermissive and p.polcmd in ('a','w','d','*')
      and not (p.polname = any(keep));
    if remaining <> 0 then
      raise exception '0323 FAILED: % permissive write policy(ies) still on % after the sweep', remaining, spec.tbl;
    end if;
  end loop;

  raise notice '0323 OK: % stray write policy(ies) swept across 9 health tables; a health record is the subject''s, the author''s or a manager''s', swept;
end $$;
