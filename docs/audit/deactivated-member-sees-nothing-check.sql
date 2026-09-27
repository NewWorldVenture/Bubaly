-- ── A removed member reads nothing, and WHY that holds ──────────────────────
--
-- Thirteen policies across eleven tables still use the legacy inline form
--
--     family_id in (select family_id from family_members where user_id = auth.uid())
--
-- which, unlike `is_family_member()`, contains no `is_active` check. Read on its
-- own it looks like a removed family member keeps access to photos, messages,
-- conversations, contacts and the family tree.
--
-- They do not, and the reason is NOT in those policies. The subquery runs as the
-- caller, so it is itself subject to `family_members`' RLS — and `fm_select` is
-- `is_family_member(family_id)`, which is SECURITY DEFINER and DOES check
-- `is_active`. A deactivated member cannot see their own membership row, so the
-- subquery returns empty and all thirteen policies evaluate false.
--
-- THAT IS A SINGLE POINT OF COUPLING NOTHING ELSE RECORDS. Widening
-- `fm_select` — an innocent-looking change, "let members see the roster" — would
-- silently re-open all thirteen at once. This probe is the tripwire: it fails
-- the moment that stops being true, and names why.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/deactivated-member-sees-nothing-check.sql
--
-- Audit C1-S6-07.
do $$
declare
  fam  uuid := 'f0306000-0000-4000-8000-00000000fa01';
  par  uuid := 'f0306000-0000-4000-8000-00000000c001';
  gone uuid := 'f0306000-0000-4000-8000-00000000c009';
  n int;
begin
  insert into public.families (id, name) values (fam, '0306 removed member') on conflict do nothing;
  insert into auth.users (id, email) values
    (par, 'p0306@example.test'), (gone, 'x0306@example.test') on conflict do nothing;
  delete from public.todo_items      where family_id = fam;
  delete from public.todo_lists      where family_id = fam;
  delete from public.family_recipes  where family_id = fam;
  delete from public.family_contacts where family_id = fam;
  delete from public.family_members  where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par,  'Parent',          'parent', true),
    (fam, gone, 'Removed partner', 'adult',  false);

  -- Seeded: "reads zero rows" proves nothing against an empty table, which is
  -- the defect class this audit is named for.
  insert into public.todo_lists      (family_id, name)           values (fam, 'Household to-do');
  insert into public.family_recipes  (family_id, name)           values (fam, 'Sunday roast');
  insert into public.family_contacts (family_id, name)           values (fam, 'Dr Alvarez');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', gone::text, true);
  if auth.uid() is distinct from gone then
    raise exception '0306: impersonation failed — auth.uid() is %, expected the removed member; this probe is not testing what it claims', auth.uid();
  end if;

  -- The load-bearing fact, asserted first so a failure names the cause rather
  -- than the symptom.
  select count(*) into n from public.family_members where user_id = gone;
  if n <> 0 then
    raise exception '0306: a DEACTIVATED member can see % of their own membership row(s) — fm_select no longer hides them, so every legacy `family_id in (select … from family_members)` policy is now open to removed members', n;
  end if;

  select count(*) into n from public.todo_lists where family_id = fam;
  if n <> 0 then raise exception '0306: a removed member reads % todo_lists row(s)', n; end if;
  select count(*) into n from public.family_recipes where family_id = fam;
  if n <> 0 then raise exception '0306: a removed member reads % family_recipes row(s)', n; end if;
  select count(*) into n from public.family_contacts where family_id = fam;
  if n <> 0 then raise exception '0306: a removed member reads % family_contacts row(s)', n; end if;

  -- The family itself must still work, or the tripwire would pass on a
  -- database where nobody can read anything.
  perform set_config('request.jwt.claim.sub', par::text, true);
  select count(*) into n from public.todo_lists where family_id = fam;
  if n <> 1 then raise exception '0306: an ACTIVE parent reads %/1 todo_lists row(s) — this probe is measuring a broken database, not a boundary', n; end if;

  reset role;
  raise notice '0306 OK: a removed member sees nothing, because fm_select still hides their own membership row; an active parent still sees everything';
end $$;
