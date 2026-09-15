-- ── 0302: one live system policy per family, per name ────────────────────────
--
-- `setConciergeAutopilotAction` is a check-then-insert over
-- (family_id, name='Concierge autopilot'), and `trust_policies` had exactly one
-- unique index: the primary key on `id`. The read error was not destructured,
-- which is what made the failure self-worsening rather than merely racy — with
-- two rows present the single-row read fails, `existing?.id` is undefined, and
-- the action's else-branch adds a THIRD. A parent's control over whether Bubaly
-- acts on its own stops taking effect and stops reporting its own state.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/system-policy-uniqueness-check.sql
--
-- The index is partial on `enabled` because the repair DISABLES rather than
-- deletes: a disabled row leaves the engine (loadTrustInputs filters
-- enabled = true) without a household losing a row to make an index fit.
--
-- Re-runnable: the fixture family's rows are cleared before each run.
do $$
declare
  fam uuid := 'e0302000-0000-4000-8000-00000000fa01';
  usr uuid := 'e0302000-0000-4000-8000-00000000c001';
  n int; refused boolean; surviving text;
begin
  insert into public.families (id, name) values (fam, '0302 trust') on conflict (id) do nothing;
  insert into auth.users (id, email) values (usr, 'p0302@example.test') on conflict (id) do nothing;
  delete from public.trust_policies where family_id = fam;

  insert into public.trust_policies
    (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
  values (fam, 'Concierge autopilot', 'all', 'automate', 'ai', 'allow', 10, true, true, usr);

  -- 1. A second LIVE system policy under the same name must be refused. Without
  --    this the dial silently accumulates rivals.
  refused := false;
  begin
    insert into public.trust_policies
      (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
    values (fam, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, true, true, usr);
  exception when unique_violation then refused := true;
  end;
  if not refused then
    select count(*) into n from public.trust_policies
     where family_id = fam and name = 'Concierge autopilot' and is_system and enabled;
    raise exception '0302: a family holds % live autopilot policies — the dial has rivals and the single-row read that drives it fails', n;
  end if;

  -- 2. A DISABLED duplicate must still be storable: the repair disables rather
  --    than deletes, and that is only safe if the index leaves such rows alone.
  insert into public.trust_policies
    (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
  values (fam, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, false, true, usr);
  select count(*) into n from public.trust_policies where family_id = fam and name = 'Concierge autopilot';
  if n <> 2 then
    raise exception '0302: a superseded policy could not be kept alongside the live one (% rows) — the repair would have to delete', n;
  end if;

  -- 3. What the engine loads is still exactly one.
  select count(*) into n from public.trust_policies where family_id = fam and enabled;
  if n <> 1 then
    raise exception '0302: loadTrustInputs would see % enabled policies for this family', n;
  end if;

  -- 4. The other direction: a family's OWN policies are not system policies and
  --    must stay free to share a name across domains. An index that reached
  --    them would be a different bug.
  insert into public.trust_policies
    (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
  values (fam, 'Weekend rules', 'calendar', 'edit', 'ai', 'allow', 100, true, false, usr),
         (fam, 'Weekend rules', 'finances', 'view', 'ai', 'allow', 100, true, false, usr);
  select count(*) into n from public.trust_policies where family_id = fam and name = 'Weekend rules';
  if n <> 2 then
    raise exception '0302: the index reached a family''s hand-written policies (% of 2 kept)', n;
  end if;

  -- 5. The repair keeps the parent's LATEST intent, not an arbitrary row.
  delete from public.trust_policies where family_id = fam;
  insert into public.trust_policies
    (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by, updated_at)
  values (fam, 'Repair probe', 'all', 'automate', 'ai', 'allow', 10, true, true, usr, now() - interval '3 days'),
         (fam, 'Repair probe', 'all', 'automate', 'ai', 'deny',  10, false, true, usr, now() - interval '1 hour');
  select effect into surviving from public.trust_policies
   where family_id = fam and name = 'Repair probe' and enabled;
  if surviving is distinct from 'allow' then
    raise exception '0302: fixture wrong — expected the live row to be the allow one, got %', surviving;
  end if;

  delete from public.trust_policies where family_id = fam;
  raise notice '0302 system policy uniqueness OK';
end $$;

-- The index itself, from the catalog: a later migration can drop one, and a
-- constraint that is gone fails nothing until something depends on it.
do $$
declare idx text; begin
  select pg_get_indexdef(c.oid) into idx
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'uq_trust_policies_live_system_name';
  if idx is null then
    raise exception '0302: uq_trust_policies_live_system_name is gone';
  end if;
  if idx !~ 'is_system' or idx !~ 'enabled' then
    raise exception '0302: the index lost its partial predicate: %', idx;
  end if;

  if exists (
    select family_id, name from public.trust_policies
     where is_system and enabled group by family_id, name having count(*) > 1
  ) then
    raise exception '0302: some family holds two live system policies with one name';
  end if;
  raise notice '0302 system policy index OK';
end $$;
