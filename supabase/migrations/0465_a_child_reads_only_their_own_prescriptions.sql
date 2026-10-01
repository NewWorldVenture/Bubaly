-- Bubaly :: 0465 - a child reads only their own prescriptions
--                   (F-G09, the read half; audit/claude-1.md A3-009)
-- ----------------------------------------------------------------------------
-- F-G09 was closed in two halves and left one filed. 0309 and 0434 made the
-- WRITES on `medications` and `medication_schedules` a parent's or adult's
-- (restrictive `*_manager_*_guard` policies over permissive `*_mng_*` ones);
-- 0414 and 0430 did the same for `immunizations` and `health_visits`, whose
-- modules now hide Add / Edit / Delete from a non-manager. What stayed open,
-- as an OWNER DECISION, was the read: every member selected every row, so a
-- child read a parent's sertraline, a sibling's ADHD prescription, its dosage,
-- its instructions and the whole family's adherence history.
--
-- The owner decided: PARENTS WRITE, KIDS SEE THEIR OWN.
--
--   medications            a manager (can_manage_family) reads the family's
--                          rows; anyone else reads the rows whose `member_id`
--                          is their own member row
--   medication_schedules   follow their medication: readable exactly when the
--                          medication is
--   medication_doses       READS: a manager reads the family's; anyone else a
--                          dose that is recorded for their own member row AND
--                          whose medication they can read. WRITES stay any
--                          member's, as 0309, 0414 and 0434 left them — the
--                          person taking the medicine is the one who ticks it
--
-- Every write guard from 0309 / 0434 is left exactly as it is, and the
-- post-condition below raises if any of the six is missing.
--
-- ── the rows with no member ───────────────────────────────────────────────
--
-- `medications.member_id` is nullable, and the module labels a NULL "Whole
-- family". It is NOT evidence that a row is meant for everyone to read:
-- medications-module.tsx's blank form starts with `member_id: ''`, which the
-- "For" select shows as "Whole family" and saveMed turns into NULL. So a parent
-- who types their own prescription and does not touch "For" files it as family-
-- wide — and 0434's own probe fixture is exactly that, a parent's Sertraline
-- with member_id NULL. Treating NULL as "everyone may read" would leave the
-- commonest parent prescription as visible to a child as it was before.
--
-- So a row with no member is a MANAGER's to read. A medicine that really is
-- for a child is assigned to that child, which is what makes it theirs; the
-- child's dose buttons, reminders and refill badge all key off that same
-- `member_id` already (dosesForDay, lib/server/notifications.ts). The module
-- tells a non-manager they are seeing the medicines prescribed to them, so the
-- shorter list reads as the rule and not as a failed load.
--
-- ── why doses narrow too ──────────────────────────────────────────────────
--
-- lib/ai/context/policy.ts lists `medication_doses` beside the other two as
-- "prescriptions". A dose row carries the medication it belongs to, the member,
-- whether it was taken or skipped and a free-text `notes`; leaving it family-
-- wide would keep a sibling's adherence history readable after hiding the
-- prescription it is the history of. The module already reads doses only
-- for medications it can see (windowDoseLogs, todayDoses), so for a child it
-- changes nothing on screen.
--
-- A dose is the history of ONE person's taking, so it is that person's, not
-- whoever holds the medication now (#674 comment 5922523738). A parent can
-- reassign a medication from one child to another (the module's edit keeps
-- the row and changes `member_id`, and does not rewrite past doses); following
-- only the medication's current owner would hand child B child A's taken /
-- skipped history and its free-text notes. So a non-manager's dose read needs
-- BOTH: the medication is readable to them, and the dose's own `member_id` is
-- theirs. After a reassignment B sees the doses B records, A no longer sees
-- the medication or its doses, and a manager sees all of them. A dose whose
-- member was deleted (`member_id` SET NULL) is a manager's to read.
--
-- The one FOR ALL policy there ("Members can manage medication_doses", 00261)
-- is split into a narrowed SELECT and three member-wide write policies with
-- the very predicate it granted, so the write surface is the same text as
-- before. A child's own dose still inserts, updates (a second tap) and deletes
-- (a tap on the same status) — the probe drives all three — because the
-- child's own dose is one the narrowed SELECT still shows. A SELECT policy
-- also bounds the rows an UPDATE or DELETE with a WHERE can reach, so a child
-- can no longer rewrite a sibling's tick, which was the residual 0434 filed
-- as "an accountability nit"; no screen offered it.
--
-- ── the shape ─────────────────────────────────────────────────────────────
--
-- Reads are not writes, so neither the restrictive-write + `.select('id')`
-- client rule (tests/a-filtered-delete-is-not-a-deletion.test.ts and
-- docs/audit/gated-write-tables-check.sql, which classify UPDATE / DELETE /
-- ALL policies only) nor 0464's raising trigger (SELECT has no trigger) is
-- the tool. 0438's is: ONE permissive SELECT policy per table, a sweep BY
-- SHAPE of every other permissive SELECT or FOR ALL policy (permissive
-- policies OR, so one leftover restores the family-wide read and nothing would
-- say so), and here also a RESTRICTIVE select guard with the same predicate,
-- so a permissive read added later cannot reopen the boundary on its own —
-- 0254's mechanism, applied to the read.
--
-- `is_family_member(family_id)` stays as the outer term although
-- can_manage_family implies it, for 0438's reason: is_self_member checks only
-- that the MEMBER row is mine, not the medication's family_id.
--
-- The schedule and dose predicates read `medications` in a subquery. That
-- subquery runs as the caller, under 0465's medications policy, and the
-- `is_self_member(m.member_id)` in it says the same thing explicitly rather
-- than leaning on that. No policy on `medications` reads the other two tables,
-- so there is no cycle.
--
-- ── the other readers ─────────────────────────────────────────────────────
--
-- The reminder crons (lib/server/notifications.ts via api/cron/*), the
-- autopilot scan and the morning-briefing delivery run on the SERVICE client
-- and are unaffected. The session readers — /dashboard/family-health, the
-- medical-records check-in, the AI insight for `medications`, the dashboard
-- counts — now show a child their own rows, which is the rule. The health
-- coach is the one that would have turned a short read into a false
-- statement ("Active medications: none on file" about a sibling), so it now
-- refuses a non-manager a question about another member instead
-- (app/api/ai/health/coach/route.ts).
--
-- Probes: docs/audit/prescription-write-boundary-check.sql (updated to this
-- rule) and docs/audit/a-child-reads-only-their-own-prescriptions-check.sql.
-- Idempotent: every policy is dropped-if-exists before it is created.

-- The one rule, stated once, for the two tables that hang off a medication.
-- SECURITY INVOKER on purpose: it must see `medications` as the caller does.
create or replace function public.medication_is_readable(p_medication_id uuid, p_family_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select public.is_family_member(p_family_id)
     and (
       public.can_manage_family(p_family_id)
       or exists (
         select 1 from public.medications m
         where m.id = p_medication_id
           and m.family_id = p_family_id
           and public.is_self_member(m.member_id)
       )
     );
$$;

revoke all on function public.medication_is_readable(uuid, uuid) from public, anon;
grant execute on function public.medication_is_readable(uuid, uuid) to authenticated, service_role;

do $$
declare
  t         text;
  pol       record;
  swept     int := 0;
  n         int;
  pred      text;
  own_read  text;
  keep      text[];
begin
  foreach t in array array['medications', 'medication_schedules', 'medication_doses'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0465: public.% does not exist', t;
    end if;
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- ── medication_doses: split the FOR ALL, writes word for word ─────────────
  -- Refuse to go on if the FOR ALL policy granted anything other than plain
  -- membership: splitting it must not move a write by accident.
  for pol in
    select p.polname,
           pg_get_expr(p.polqual, p.polrelid)      as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as chk
    from pg_policy p
    where p.polrelid = 'public.medication_doses'::regclass
      and p.polcmd = '*' and p.polpermissive
  loop
    if coalesce(pol.qual, '') <> 'is_family_member(family_id)'
       or coalesce(pol.chk, pol.qual, '') <> 'is_family_member(family_id)' then
      raise exception '0465: medication_doses FOR ALL policy % grants % / %, not plain membership; refusing to split it',
        pol.polname, pol.qual, pol.chk;
    end if;
  end loop;

  drop policy if exists medication_doses_member_insert on public.medication_doses;
  create policy medication_doses_member_insert on public.medication_doses
    for insert to authenticated
    with check (public.is_family_member(family_id));
  drop policy if exists medication_doses_member_update on public.medication_doses;
  create policy medication_doses_member_update on public.medication_doses
    for update to authenticated
    using (public.is_family_member(family_id))
    with check (public.is_family_member(family_id));
  drop policy if exists medication_doses_member_delete on public.medication_doses;
  create policy medication_doses_member_delete on public.medication_doses
    for delete to authenticated
    using (public.is_family_member(family_id));

  -- ── the three reads ───────────────────────────────────────────────────────
  foreach t in array array['medications', 'medication_schedules', 'medication_doses'] loop
    pred := case t
      when 'medications' then
        'public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id))'
      when 'medication_doses' then
        'public.medication_is_readable(medication_id, family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id))'
      else
        'public.medication_is_readable(medication_id, family_id)'
    end;
    own_read := t || '_select';

    execute format('drop policy if exists %I on public.%I', own_read, t);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', own_read, t, pred);

    execute format('drop policy if exists %I on public.%I', t || '_own_or_manager_read_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for select to authenticated using (%s)',
      t || '_own_or_manager_read_guard', t, pred);

    -- Sweep BY SHAPE: every other permissive policy that grants a read — a
    -- SELECT, or a FOR ALL (whose write half, on doses, is restated above).
    keep := array[own_read];
    for pol in
      select p.polname from pg_policy p
      where p.polrelid = ('public.' || t)::regclass
        and p.polpermissive
        and p.polcmd in ('r', '*')
        and not (p.polname = any(keep))
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0465: dropped permissive read policy %.%', t, pol.polname;
    end loop;

    select count(*) into n from pg_policy p
    where p.polrelid = ('public.' || t)::regclass
      and p.polpermissive and p.polcmd in ('r', '*')
      and p.polname <> own_read;
    if n <> 0 then
      raise exception '0465 FAILED: % other permissive read policy(ies) still on %, which OR the narrowing away', n, t;
    end if;
  end loop;

  -- ── post-conditions ───────────────────────────────────────────────────────
  -- 0309 / 0434's six write guards are still here, and still restrictive.
  select count(*) into n from pg_policy p
  where p.polrelid in ('public.medications'::regclass, 'public.medication_schedules'::regclass)
    and not p.polpermissive
    and p.polname in (
      'medications_manager_insert_guard', 'medications_manager_update_guard', 'medications_manager_delete_guard',
      'medication_schedules_manager_insert_guard', 'medication_schedules_manager_update_guard',
      'medication_schedules_manager_delete_guard');
  if n <> 6 then
    raise exception '0465 FAILED: expected the six restrictive prescription write guards from 0309/0434, found %', n;
  end if;

  -- The three restrictive read guards.
  select count(*) into n from pg_policy p
  where p.polname in ('medications_own_or_manager_read_guard',
                      'medication_schedules_own_or_manager_read_guard',
                      'medication_doses_own_or_manager_read_guard')
    and not p.polpermissive and p.polcmd = 'r';
  if n <> 3 then
    raise exception '0465 FAILED: expected three restrictive read guards, found %', n;
  end if;

  -- A dose is still any member's to write: insert, update and delete each have
  -- a plain-membership permissive policy and nothing restrictive beyond 0338's
  -- attribution guard on insert.
  select count(*) into n from pg_policy p
  where p.polrelid = 'public.medication_doses'::regclass
    and p.polpermissive and p.polcmd in ('a', 'w', 'd')
    and coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) = 'is_family_member(family_id)';
  if n <> 3 then
    raise exception '0465 FAILED: medication_doses should keep three member-wide write policies, found %', n;
  end if;

  raise notice '0465 OK: % read policy(ies) swept; a manager reads the family''s prescriptions, anyone else their own, and a dose is still any member''s to record', swept;
end $$;
