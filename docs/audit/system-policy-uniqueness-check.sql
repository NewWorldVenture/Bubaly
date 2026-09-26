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
-- Re-runnable: the fixture family's rows, and the control households', are
-- cleared before each run.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusal in check 1
-- ---------------------------------------------------------------------------
-- MECHANISM: a partial UNIQUE INDEX. Not RLS, not a trigger. That decides what
-- the control has to look like, so here is how it was established rather than
-- assumed — and, where grep is not a reliable witness in this repository, how
-- the catalog block at the foot re-establishes it from pg_index and pg_trigger
-- on every run:
--
--   * `grep -l uq_trust_policies_live_system_name supabase/migrations` returns
--     exactly one file, 0302_one_live_system_policy.sql, which creates it as
--     `unique (family_id, name) where is_system and enabled`. Only 0257 and
--     0327 mention `trust_policies` after that and both only in prose — no
--     migration drops or re-creates this index, the way 0297 silently replaced
--     0105's child_logins policy on a different predicate.
--   * ONE migration puts a trigger on public.trust_policies, and a grep for
--     `create trigger … on public.trust_policies` does not find it: 0093
--     attaches `trust_policies_updated_at` through `EXECUTE format(...)` over a
--     table-name array (0093 lines 176-184), as most trigger-creating
--     migrations in this series do. It is BEFORE UPDATE, it runs 0003's
--     set_updated_at, which only stamps `new.updated_at` and raises nothing,
--     and it cannot fire on check 1's INSERT. The guard triggers this
--     repository does refuse writes with — 0223, 0305 and 0331 on
--     chore_assignments, 0326 on chore_disputes — are not on this table.
--     Because grep cannot be trusted to say so tomorrow, the catalog block at
--     the foot asserts from pg_trigger that no non-internal trigger on this
--     table fires on INSERT (the FK-enforcement triggers Postgres owns are
--     internal and raise 23503, not 23505). And the control's baseline leg is
--     what notices, at run time, if one is added and refuses.
--   * The table does have RLS (0093's trust_policies_read / trust_policies_write,
--     the only policies on it). This probe never switches role and `usr` has no
--     family_members row, so if RLS applied to this session the very first
--     write to the table — the control's guarded baseline leg — would be
--     refused with 42501 and reported as CONTROL FAILED, SQLSTATE in the
--     message, before check 1 ever ran. And the refusal under test is caught as
--     `unique_violation` specifically, which neither an RLS policy nor a CHECK
--     constraint raises.
--
-- Check 1 is the only refusal in this file; every other check asserts that a
-- write LANDS, and nothing here asserts ZERO ROWS, so the can't-see-the-row
-- hazard does not apply. The hazard that does apply is crediting 0302's index
-- for a 23505 that some OTHER constraint raised, or for one raised by an index
-- of that name whose shape is not the one 0302 wrote. Three things close it,
-- and each covers what the others cannot:
--
--   * the control below: four legs that must LAND when the refused row is
--     changed in exactly one keyed dimension. A key that is a SUBSET of
--     (family_id, name), or a predicate that drops `enabled` or `is_system`,
--     refuses one of them — and it does so before checks 2, 4 and 5 would
--     abort on an unattributed duplicate-key error.
--   * check 1 reads the refusing constraint's name from the error (GET STACKED
--     DIAGNOSTICS CONSTRAINT_NAME) and requires it to be
--     uq_trust_policies_live_system_name. A 23505 from any other index is
--     reported by name, not credited.
--   * the catalog block reads pg_index and requires the index to be UNIQUE,
--     keyed on exactly (family_id, name) and partial on is_system and enabled.
--     A SUPERSET key — `(family_id, name, priority)`, say — is the one shape
--     the control cannot see: check 1's fixture and its duplicate agree on
--     every column but `effect`, so all four legs land and check 1 is still
--     refused. It is caught here instead.
--
-- The four legs, one per keyed dimension, and every one of them MUST LAND:
--
--   family_id  the same live system name in a SECOND family. Refused means the
--              constraint keys on `name` without `family_id`: check 1 stays
--              green while no household after the first can hold an autopilot
--              dial at all.
--   name       a second live system policy in the SAME family under a DIFFERENT
--              name. Refused means the rule is "one live system policy per
--              family", not "per family, per name" — a different invariant from
--              the one this file is named for. The catalog block would also
--              see it in pg_index, but only after checks 2, 4 and 5 had died on
--              a raw duplicate-key error; the leg says why first.
--   enabled    the disabled duplicate. Refused means the constraint is not
--              partial, so 0302's repair — disable, do not delete — was never
--              actually available, and check 2 dies on a raw "duplicate key
--              value violates unique constraint" with the diagnosis thrown away.
--   is_system  a hand-written duplicate. Refused means the constraint reaches a
--              family's own policies, which check 4 would then report as that
--              same unattributed duplicate-key abort.
--
-- A baseline leg runs ahead of the four: the very row check 1 expects to be
-- refused — same column list, same values, effect 'deny' included — inserted
-- into a family holding nothing, must land. That is the same existence proof
-- the child_logins control opens with. If it is refused, a revoked GRANT, a
-- column-level denial, a new CHECK or a freshly added guard trigger is
-- refusing every write to this table, and check 1's unique_violation handler
-- would be crediting the index for someone else's no.
--
-- Every leg also checks ROW_COUNT, and that arm is not decoration: a
-- single-row INSERT ... VALUES that raises nothing and stores nothing is
-- exactly what a BEFORE INSERT trigger returning NULL, or a DO INSTEAD rule,
-- produces. That is a refusal that never says no, and no exception handler in
-- this file would ever see it.
--
-- The legs run in households of their own and delete their rows before check 1,
-- because run-probes.sh runs every docs/audit/*-check.sql against ONE database
-- in sequence and the catalog check at the foot of this file scans every family
-- in it.
do $$
declare
  fam uuid := 'e0302000-0000-4000-8000-00000000fa01';
  usr uuid := 'e0302000-0000-4000-8000-00000000c001';
  -- The control's own households, so nothing it stores can move a count the
  -- five checks below take.
  ctl_a uuid := 'e0302000-0000-4000-8000-00000000fa02';
  ctl_b uuid := 'e0302000-0000-4000-8000-00000000fa03';
  control_ok boolean := true;
  failures text[] := '{}';
  n int; refused boolean; refusing text; surviving text;
begin
  insert into public.families (id, name) values (fam, '0302 trust') on conflict (id) do nothing;
  insert into auth.users (id, email) values (usr, 'p0302@example.test') on conflict (id) do nothing;
  delete from public.trust_policies where family_id = fam;

  -- ── NEGATIVE CONTROL: the same insert, one keyed thing changed, must land ──
  -- Runs before check 1, because a refusal is only evidence about this index if
  -- this session can store the very row that gets refused. Same column list as
  -- check 1 throughout — an insert's analogue of naming the same columns in an
  -- UPDATE control: a column-level revoke or a new NOT NULL/CHECK on any of
  -- these columns shows up HERE, instead of being read as the index saying no.
  insert into public.families (id, name) values (ctl_a, '0302 control A') on conflict (id) do nothing;
  insert into public.families (id, name) values (ctl_b, '0302 control B') on conflict (id) do nothing;
  delete from public.trust_policies where family_id in (ctl_a, ctl_b);

  -- Baseline: the row check 1 expects to be refused — same values, effect
  -- 'deny' — into a family holding nothing. Nothing about the index can refuse
  -- this one.
  begin
    insert into public.trust_policies
      (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
    values (ctl_a, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, true, true, usr);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: the first live system policy in an EMPTY family stored 0 rows and raised nothing — no constraint does that; a BEFORE INSERT trigger returning NULL or a DO INSTEAD rule is silently dropping writes to trust_policies, and check 1''s refusal would measure nothing about the index');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: the first live system policy in an EMPTY family was refused (%s: %s) — a revoked GRANT, a column denial, a new CHECK or a guard trigger is refusing every write to trust_policies, and check 1''s handler would credit the index for someone else''s no', sqlstate, sqlerrm));
  end;

  -- Keyed on family_id: the same live system name in a SECOND household.
  if control_ok then
    begin
      insert into public.trust_policies
        (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
      values (ctl_b, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, true, true, usr);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a SECOND family''s live system policy under a name the first already uses stored 0 rows and raised nothing — no constraint does that; a BEFORE INSERT trigger returning NULL or a DO INSTEAD rule is silently dropping same-name writes to trust_policies');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a SECOND family was refused a live system policy under a name the first already uses (%s: %s) — whatever refuses check 1 keys on `name` without `family_id`, so check 1 stays green while no household after the first can hold an autopilot dial at all', sqlstate, sqlerrm));
    end;
  end if;

  -- Keyed on name: a second live system policy in the SAME family, other name.
  if control_ok then
    begin
      insert into public.trust_policies
        (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
      values (ctl_a, 'Concierge autopilot (control)', 'all', 'automate', 'ai', 'deny', 10, true, true, usr);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a family''s second live system policy under a DIFFERENT name stored 0 rows and raised nothing — no constraint does that; a BEFORE INSERT trigger returning NULL or a DO INSTEAD rule is silently dropping writes to trust_policies');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: one family was refused a second live system policy under a DIFFERENT name (%s: %s) — the rule being credited is "one live system policy per family", not "per family, per name": whatever refused this keys on family_id alone, and checks 2, 4 and 5 would have died on a raw duplicate-key error before the catalog block could say so', sqlstate, sqlerrm));
    end;
  end if;

  -- Keyed on the partial predicate, half one: enabled.
  if control_ok then
    begin
      insert into public.trust_policies
        (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
      values (ctl_a, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, false, true, usr);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a DISABLED duplicate stored 0 rows and raised nothing — no constraint does that; a BEFORE INSERT trigger returning NULL or a DO INSTEAD rule is silently dropping same-name writes to trust_policies, and 0302''s repair (disable, do not delete) could not be relied on');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a DISABLED duplicate was refused (%s: %s) — the constraint refusing check 1 is not partial on `enabled`, so it is not the index 0302 created, 0302''s repair (disable, do not delete) was never available, and check 2 would abort on a raw duplicate-key error with the diagnosis thrown away', sqlstate, sqlerrm));
    end;
  end if;

  -- Keyed on the partial predicate, half two: is_system.
  if control_ok then
    begin
      insert into public.trust_policies
        (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
      values (ctl_a, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, true, false, usr);
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a hand-written duplicate (is_system false) stored 0 rows and raised nothing — no constraint does that; a BEFORE INSERT trigger returning NULL or a DO INSTEAD rule is silently dropping same-name writes to trust_policies, hand-written rows included');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a family''s OWN policy was refused under a name one of its system policies already uses (%s: %s) — the constraint reaches hand-written rows, so it is not the partial index 0302 created and check 4 would report it as the same unattributed duplicate-key abort', sqlstate, sqlerrm));
    end;
  end if;

  -- The control's rows do not outlive the control. Unconditional: run-probes.sh
  -- runs every probe against ONE database in sequence, and the catalog check
  -- at the foot of this file groups over EVERY family in it — a stray live
  -- system pair here would be read as some other household's defect.
  delete from public.trust_policies where family_id in (ctl_a, ctl_b);

  -- A failed control makes check 1's refusal unreadable, and checks 2, 4 and 5
  -- insert unguarded: they would abort on a raw "duplicate key value violates
  -- unique constraint" and bury the reason. Say WHY the probe cannot speak here,
  -- while the reason is still in hand. The invariant is not reported as holding
  -- and not as broken: it is reported as unproven, and the build is red either
  -- way.
  if not control_ok then
    raise exception '0302 system policy uniqueness UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  insert into public.trust_policies
    (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
  values (fam, 'Concierge autopilot', 'all', 'automate', 'ai', 'allow', 10, true, true, usr);

  -- 1. A second LIVE system policy under the same name must be refused. Without
  --    this the dial silently accumulates rivals. And it must be refused BY
  --    0302's index: Postgres names the violated unique index in the error's
  --    CONSTRAINT_NAME, so a 23505 from any other constraint is reported as
  --    such rather than credited.
  refused := false; refusing := null;
  begin
    insert into public.trust_policies
      (family_id, name, domain, capability, subject_kind, effect, priority, enabled, is_system, created_by)
    values (fam, 'Concierge autopilot', 'all', 'automate', 'ai', 'deny', 10, true, true, usr);
  exception when unique_violation then
    refused := true;
    get stacked diagnostics refusing = constraint_name;
  end;
  if not refused then
    select count(*) into n from public.trust_policies
     where family_id = fam and name = 'Concierge autopilot' and is_system and enabled;
    raise exception '0302: a family holds % live autopilot policies — the dial has rivals and the single-row read that drives it fails', n;
  end if;
  if refusing is distinct from 'uq_trust_policies_live_system_name' then
    raise exception '0302: the duplicate was refused by "%", not by uq_trust_policies_live_system_name — some other unique constraint is doing the refusing, and this probe would be crediting 0302''s index for it', coalesce(refusing, '(no constraint named)');
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
  raise notice '0302 system policy uniqueness OK — control held: the same insert lands when family_id, name, enabled or is_system is the one thing that differs, and check 1''s unique_violation named uq_trust_policies_live_system_name';
end $$;

-- The index itself, from the catalog: a later migration can drop one, and a
-- constraint that is gone fails nothing until something depends on it. Read
-- from pg_index rather than only regex over the indexdef, so the KEYED columns
-- are checked too — the control above cannot see a superset key, because check
-- 1's fixture and its duplicate agree on every column it could add.
do $$
declare
  idx text; keyed text[]; pred text; is_unique boolean; ins_triggers text;
begin
  select pg_get_indexdef(c.oid), i.indisunique,
         (select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey) with ordinality as k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum),
         pg_get_expr(i.indpred, i.indrelid)
    into idx, is_unique, keyed, pred
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_index i on i.indexrelid = c.oid
   where n.nspname = 'public' and c.relname = 'uq_trust_policies_live_system_name';
  if idx is null then
    raise exception '0302: uq_trust_policies_live_system_name is gone';
  end if;
  if idx !~ 'is_system' or idx !~ 'enabled' then
    raise exception '0302: the index lost its partial predicate: %', idx;
  end if;
  if not is_unique then
    raise exception '0302: uq_trust_policies_live_system_name is no longer UNIQUE, so it refuses nothing: %', idx;
  end if;
  if keyed is distinct from array['family_id', 'name'] then
    raise exception '0302: the index keys on % rather than exactly (family_id, name) — a superset key still refuses check 1''s duplicate and lands every control leg, and it is not the invariant this file is named for: %', keyed, idx;
  end if;
  if pred is null then
    raise exception '0302: the index is no longer partial — a disabled duplicate would be refused and 0302''s repair (disable, do not delete) is unavailable: %', idx;
  end if;

  -- The header's claim about triggers, settled from pg_trigger rather than
  -- grep, because this repository attaches most triggers through EXECUTE
  -- format() over table-name arrays and a grep for the literal statement
  -- misses them. Today the only non-internal trigger on this table is 0093's
  -- BEFORE UPDATE updated_at stamp, which cannot touch check 1's INSERT. A
  -- trigger that fires on INSERT changes what could be refusing the duplicate
  -- and what the control's baseline leg is measuring; it is named here so the
  -- attribution above gets re-read rather than silently outdated.
  select string_agg(format('%s (%s)', t.tgname, p.proname), ', ' order by t.tgname)
    into ins_triggers
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
   where n.nspname = 'public' and c.relname = 'trust_policies'
     and not t.tgisinternal
     and (t.tgtype & 4) <> 0;   -- TRIGGER_TYPE_INSERT
  if ins_triggers is not null then
    raise exception '0302: a trigger now fires on INSERT into trust_policies — % — so "the only trigger on this table is 0093''s BEFORE UPDATE updated_at stamp" is no longer true; re-establish what refuses check 1''s duplicate before trusting this probe''s attribution', ins_triggers;
  end if;

  if exists (
    select family_id, name from public.trust_policies
     where is_system and enabled group by family_id, name having count(*) > 1
  ) then
    raise exception '0302: some family holds two live system policies with one name';
  end if;
  raise notice '0302 system policy index OK — UNIQUE on exactly (family_id, name), partial on %, and no non-internal trigger on trust_policies fires on INSERT', pred;
end $$;
