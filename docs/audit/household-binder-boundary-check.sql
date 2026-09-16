-- ── 0309: the binder's sensitive rows are not child-readable ────────────────
--
-- household_info carries `is_sensitive`, the UI masks such a value behind an
-- eye toggle, and the policy was one `FOR ALL USING is_family_member` — so the
-- mask hid a value the browser already held. Measured before the fix: a child
-- read `hunter2-alarm-4417` in the clear.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/household-binder-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S6-06.
do $$
declare
  fam uuid := 'f0309000-0000-4000-8000-00000000fa01';
  par uuid := 'f0309000-0000-4000-8000-00000000c001';
  kid uuid := 'f0309000-0000-4000-8000-00000000c003';
  n int; refused boolean;
begin
  insert into public.families (id, name) values (fam, '0309 binder boundary') on conflict do nothing;
  insert into auth.users (id, email) values
    (par, 'p0309@example.test'), (kid, 'k0309@example.test') on conflict do nothing;
  delete from public.household_info where family_id = fam;
  delete from public.family_members where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, par, 'Parent', 'parent', true),
    (fam, kid, 'Kid', 'child', true);
  -- Seeded deliberately: an assertion that a child reads zero rows passes
  -- against an empty table whatever the policy says, which is the defect class
  -- this whole audit is about.
  insert into public.household_info (family_id, category, label, value, is_sensitive) values
    (fam, 'wifi',  'Home wifi password', 'hunter2-alarm-4417', true),
    (fam, 'other', 'Bin day',            'Tuesday',            false);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    raise exception '0309: impersonation failed — auth.uid() is %, expected the child; this probe is not testing what it claims', auth.uid();
  end if;

  select count(*) into n from public.household_info where family_id = fam and is_sensitive;
  if n <> 0 then
    raise exception '0309: a child reads % sensitive binder row(s) — alarm codes and wifi keys', n;
  end if;

  -- The binder must still BE a binder for everyone else.
  select count(*) into n from public.household_info where family_id = fam and not is_sensitive;
  if n <> 1 then
    raise exception '0309: a child reads %/1 ordinary binder row(s) — the fix went too far', n;
  end if;

  -- `with check`: without it a child clears the flag, reads the value, sets it back.
  update public.household_info set is_sensitive = false where family_id = fam and is_sensitive;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0309: a child un-flagged % sensitive row(s) to read them', n;
  end if;

  refused := false;
  begin
    insert into public.household_info (family_id, category, label, value, is_sensitive)
      values (fam, 'wifi', 'Child-planted secret', 'x', true);
  -- Only the RLS refusal counts; `when others` would let a renamed column
  -- report the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0309: a child inserted a sensitive binder row';
  end if;

  perform set_config('request.jwt.claim.sub', par::text, true);
  if auth.uid() is distinct from par then
    raise exception '0309: impersonation failed — auth.uid() is %, expected the parent', auth.uid();
  end if;
  select count(*) into n from public.household_info where family_id = fam;
  if n <> 2 then
    raise exception '0309: a PARENT sees %/2 binder rows — the grown-ups were locked out', n;
  end if;

  reset role;
  raise notice '0309 OK: a child keeps the bin day and never sees the wifi key; a parent keeps both';
end $$;
