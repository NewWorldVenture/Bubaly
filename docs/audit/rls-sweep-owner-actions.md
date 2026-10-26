# RLS rewrites lane: owner actions (SQL, not applied)

This document is the owner's copy of every database change the RLS rewrites lane (finalaudit.md, RLS rows) recommends for migration 0481's household-table policies and 0483's circle-management functions. Nothing here has been applied to any production database, and nothing here is under supabase/. Each action was run on a private Postgres 16 copy of main's migrations (0001 to 0486, plus SEED_ALL), applied twice (the second run a no-op), with its probes run before and after; the results are stated with each action. The N1-residual entry is an owner decision with two options, (a) and (b); apply at most one.


## FINAL OWNER-ACTION SET, round 4 (RLS rewrites lane: 0481 household-table policies, 0483 circle-management functions)

FINAL OWNER-ACTION SET, round 4 (RLS rewrites lane: 0481 household-table policies, 0483 circle-management functions). Commit 7ca62247573e954378dad746eab8e097063dbf58 on audit/rls-sweep-fix-r4. It replaces round 3's unresolved list. Every entry is owner SQL or an owner decision. Nothing under supabase/ or docs/audit/ was edited.

What changed since round 3:
- #1's (e) keeps a dose marked 'taken' on the family's today, and its (c') report and advice are corrected (OA1-e/taken-today).
- #3's (a) is the reviewer's candidate plus one tightening (N12-purchased/db-unbuy).
- Option (b) gains a caveat.
- #2, #4, the N1-residual decision and option (a) are unchanged.

HOW EVERYTHING WAS MEASURED:
- Server: the shared Postgres 16 at host /home/user/rlspg, port 55460. Each private copy was made with `createdb -T rls_tpl`. I never connected to rls_tpl and never ran verify-pg.sh. All copies are dropped.
- Files were run with `psql -v ON_ERROR_STOP=1 -f`. Each probe rolls back. An older file was checked against a newer probe by a 'wrap' (begin; \i <file>; \i <probe>), which the probe's rollback undoes.
- Members act with `set local role authenticated` and request.jwt.claims {sub, role: authenticated}, inside each probe's p_try.

The copies:
- Copy A: seed-n12-claims, seed-oa1-planted-r3 and seed-oa2-preexisting were COMMITTED first. Then the 'before' probes ran. Then #1 r4, #2, #3 r4 and #4 (ii) were each applied twice, and the 'after' probes ran. Then option (a) was applied twice.
- Copy B (fresh): the suite ran first. Then seed-n12, #3 r4, #1 r4, option (b) part 1 and part 2, then #2 and #4, each applied twice.
- Copy C: #1 r4 twice, then the held supabase/reserved/0511, then option (a) twice.

IDEMPOTENCE. On fresh copies D and E, each file was applied twice, with a schema fingerprint after each application: an md5 of the public functions with their ACLs, the policies, the non-internal triggers and the indexes.
- The files: #1 r4, #2, #3 r4, #4 (ii) and option (a) on D; #1 r4 and option (b) parts 1 and 2 on E.
- For every file, the first application changed the fingerprint and the second left it identical.
- The DML repairs match 0 rows on the second run: #1 (d)/(e) UPDATE 0/0, #2 (9) 'closed 0 ... 0 ... 0', #3 (b) UPDATE 0.

docs/audit SUITE (every docs/audit/*-check.sql, 189 files):
- B fresh: 189/189.
- B with seed-n12, #3, #1 and option (b): 189/189.
- C with #1, the held 0511 and option (a): 189/189. The held docs/audit/reserved/a-medication-is-read-by-managers-its-member-and-caregivers-check.sql printed OK, and so did prescription-write-boundary.
- A with the seeds, #1-#4 and option (a): 188/189. B with #1-#4 and option (b): 188/189. The one failure is gated-write-tables ('A migration narrowed writes on 1 table(s) that the client guard does not know about: expense_splits'), which is #4's release step. With that line added, the check printed 'OK: 174 tables ...'.

The 'today' of the seeded OA1 probes is the UTC day. All runs were between 21:26 and 22:30 UTC on 2026-10-23. rv-oa1-e-edges-r4 covers the family's own day in four zones.

Each entry below carries its full SQL and every probe it names, verbatim, under its own heading. The file names in the headings are the names the audit ran them under; they are not migrations in supabase/migrations.

### IDEMPOTENCE FINGERPRINT: fingerprint.sql

```sql
-- Schema fingerprint of what the owner actions write: functions, policies, triggers and indexes of
-- schema public, plus the function grants. Equal before and after a re-application means the
-- second application changed no definition.
select 'functions', md5(string_agg(pg_get_functiondef(p.oid) || coalesce(array_to_string(p.proacl, ','), ''), E'\n' order by p.oid::regprocedure::text))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind in ('f', 'p')
union all
select 'policies', md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, permissive, roles, cmd, qual, with_check), E'\n' order by tablename, policyname))
  from pg_policies where schemaname = 'public'
union all
select 'triggers', md5(string_agg(pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text, E'\n' order by c.relname, t.tgname))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
union all
select 'indexes', md5(string_agg(indexdef, E'\n' order by tablename, indexname))
  from pg_indexes where schemaname = 'public';
```

## OWNER ACTION #1 (N1 + N2 + N3, OA1-no-repair, and OA1-e/taken-today)

OWNER ACTION #1 (N1 + N2 + N3, OA1-no-repair, and OA1-e/taken-today). SQL, to apply as one migration. It replaces round 3's #1.

Unchanged: the guard policies medication_doses_matches_med_guard and _update_guard, the guest triggers on medication_doses and care_log, the report (c) and the repair (d).

Round 4 changes:
- (e) gains `and not (c.status = 'taken' and (c.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date)`, and its candidates select d.status.
- (c') reports unscheduled_by_e (what (e) changes) and kept_as_taken_today, in place of holds_a_live_slot. The owner reviews the kept rows: a genuine dose stays; one judged planted, or one the medicine's new member still has to take, is deleted by id, which frees today's slot.
- The advice is corrected: re-running (e) after a 'For' change frees the slots such rows hold after today, and today's slot when its row is not 'taken'. A dose taken today keeps today's slot. To accept a second log instead, drop the last where line of (e), and the matching `and not (...)` line from (c')'s unscheduled_by_e, so that (c') reports what the edited (e) changes.

WHY. Round 3's (e) also freed a slot whose row is a dose taken today.

Measured with rv-oa1-e-edges-r4 run with round 3's (e), on copy A before anything (rolled back): 10 of 35 FAIL. That (e) made UPDATE 27, then UPDATE 0.
- It unscheduled eight rows marked 'taken' at local today 00:45 and 23:15, in America/Los_Angeles, Pacific/Kiritimati, UTC and the unknown 'Mars/Olympus' (counted as UTC).
- It also unscheduled a manager's member-null 'taken' 08:00 of today's family-wide Vitamin D. The module writes a family-wide dose with member_id null (components/modules/medications-module.tsx:325-329). The medicine was then given to the child, as saveMed does (:349-358).
- The child (role authenticated) then ran `insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by) values (<fam>, <Vitamin D>, <its 08:00 schedule>, <child>, <today 08:00>, 'taken', now(), <child uid>)` and got 1: a second 'taken' for one slot.

With round 4's (e), the same probe gave 35 of 35, with UPDATE 17, then UPDATE 0:
- the 'taken today' rows keep their slot;
- the same insert got error:23505 (uq_med_doses_slot);
- the child's insert of tomorrow's 08:00 got 1.

The app paths:
- logDose logs only today's slots (medications-module.tsx:289-295), so a 'taken' row in the live window is today's.
- On a manager's screen the kept row disables the slot: targetUnavailable (:484-486), 'This dose changed' (:501), and the buttons at :504 and :510.
- On the screen of the medicine's own non-manager member (a child, teen or caregiver reads only their own doses: medication_doses_select, and medications-module.tsx:99 and :182 load member_id = self), the slot reads pending with Taken and Skip enabled; every tap is refused with 23505 and the toast 'This dose changed' (:237-238), all that day. If that member has not had the dose, the owner deletes the kept row by id; that is the only way their slot and reminder come back that day.
- The reminder reads the slot as logged (lib/server/notifications.ts:200 reads schedule_id, scheduled_for and status only).
- From tomorrow, the row is history.
- A planted 'taken' of today is kept by the same rule, for that day only. The owner tells the two apart from (c').
- look-oa1-today-row, after #1, rolled back:
  - as the teen (role authenticated), `update public.medication_doses set status = 'skipped' where id = <dToday>` got 0, and the delete got 0;
  - as the parent, the update got 0, and `delete from public.medication_doses where id = <dToday>` got 1.
  - The screen offers no delete: logDose refuses another member's row at :308-314.

PROBES, on copy A:
(1) probe-n1-n3 (19, round 1): 9 FAIL before; 19 of 19 after #1 r4 applied twice.

(2) seed-oa1-planted-r3, then probe-oa1-repair-r4 (20). These are round 3's 18 assertions with the dToday pair changed, plus two new ones: (c') kept_as_taken_today lists exactly dToday, and the teen logs tomorrow. The changed pair: dToday keeps today's slot, and the teen's insert of today's 08:00 wants 'unique'.
- Before: 11 FAIL.
- Round 3's #1 (wrapped and rolled back): 4 FAIL, exactly the taken-today lines:
  - kept_as_taken_today had no row;
  - (c')'s list lacked dToday;
  - dToday was unscheduled;
  - the teen's insert of today's 08:00 of the drops got 1.
- #1 r4, first application: (d) UPDATE 2, (e) UPDATE 1. Second application: UPDATE 0 and UPDATE 0.
- After: 20 of 20, and still 20 of 20 after option (a).

(3) rv-oa1-e-edges-r4 (35, inline below) gave 35 of 35:
- on A, before anything, after #1-#4, and after option (a);
- on B, after #1 and #3;
- on C, after #1 and the held 0511, and after option (a).
On B after option (b) it gave 34 of 35 (see option (b)). The reviewer's verbatim rv-oa1-e-edges.sql printed '18 of 18 held' before and after, because its family-wide lines only observe.

(4) reports-r4, after #1:
- (c): 0 rows.
- (c'): 3 rows. dVpast and dReassigned are f/f; dToday has unscheduled_by_e f and kept_as_taken_today t.
- look-oa1-e-row, as the parent: update dV got 0, delete dV got 1.

On B and C (SEED_ALL only), (d) and (e) each matched 0 rows.

### OWNER ACTION #1 r4, full migration: oa1-fix-n1-n3-r4.sql

```sql
-- N1 + N2: a dose names its own medicine's schedule, on INSERT and on UPDATE.
-- 0481's medication_doses_matches_med_guard was INSERT-only and never bound
-- schedule_id to medication_id, so any non-manager (a guest included) could
-- take another member's (schedule_id, scheduled_for) slot with a dose of their
-- own or of a family-wide medicine, or move their own dose there by UPDATE.
-- 0481 [FIX 1] (a family-wide medicine is dosed by whoever takes it) is kept.
do $$
declare
  matches text := '(exists (select 1 from public.medications m'
    || ' where m.id = medication_doses.medication_id and m.family_id = medication_doses.family_id'
    || ' and (m.member_id is null or m.member_id is not distinct from medication_doses.member_id))'
    || ' and (medication_doses.schedule_id is null or exists (select 1 from public.medication_schedules s'
    || ' where s.id = medication_doses.schedule_id and s.medication_id = medication_doses.medication_id'
    || ' and s.family_id = medication_doses.family_id)))';
begin
  if to_regclass('public.medication_doses') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is missing';
  end if;
  execute 'drop policy if exists medication_doses_matches_med_guard on public.medication_doses';
  execute 'create policy medication_doses_matches_med_guard on public.medication_doses as restrictive for insert to authenticated with check ' || matches;
  execute 'drop policy if exists medication_doses_matches_med_update_guard on public.medication_doses';
  execute 'create policy medication_doses_matches_med_update_guard on public.medication_doses as restrictive for update to authenticated using ' || matches || ' with check ' || matches;
  -- a guest looks and does not log (0464's guard, raises 42501)
  execute 'drop trigger if exists trg_medication_doses_not_a_guests on public.medication_doses';
  execute 'create trigger trg_medication_doses_not_a_guests before insert or update or delete on public.medication_doses for each row execute function public.household_write_is_not_a_guests()';
end $$;

-- N3: a guest does not write care notes (0481 closed only the guest's read).
do $$
begin
  if to_regclass('public.care_log') is null then return; end if;
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception 'household_write_is_not_a_guests() (0464) is missing';
  end if;
  execute 'drop trigger if exists trg_care_log_not_a_guests on public.care_log';
  execute 'create trigger trg_care_log_not_a_guests before insert or update or delete on public.care_log for each row execute function public.household_write_is_not_a_guests()';
end $$;

-- Repair for rows written before this file. A dose written by an INSERT
-- before 0481's guard, or moved by an UPDATE 0481 never checked, can name
-- another medicine's schedule. It still holds that schedule's
-- (schedule_id, scheduled_for) slot. The update guard above refuses such a row
-- to everyone, a manager included, because its USING is the same test. The
-- Medicines screen cannot remove it either: the slot's buttons are disabled
-- with 'This dose changed' (medications-module.tsx:484-486, :501-511), and
-- logDose refuses the row (:308-314). So the slot stays blocked, and its
-- reminder is suppressed.
--
-- (c) Report (read-only), to review before (d):
--   select d.id, d.family_id, d.medication_id, d.schedule_id,
--          s.medication_id as schedule_is_for_medication, d.member_id,
--          d.scheduled_for, d.status, d.logged_by, d.created_at
--     from public.medication_doses d
--     left join public.medication_schedules s on s.id = d.schedule_id
--    where d.schedule_id is not null
--      and not exists (select 1 from public.medication_schedules s2
--                       where s2.id = d.schedule_id and s2.medication_id = d.medication_id
--                         and s2.family_id = d.family_id)
--    order by d.family_id, d.scheduled_for, d.id;
--
-- (d) One-time repair. It is re-runnable: a second run matches nothing.
--     - The row is kept as an unscheduled dose of its own medicine.
--     - It no longer holds the other schedule's slot, so the screen and the
--       reminder read that slot as not logged again.
--     - It passes the guards above, so a manager can correct or delete it.
--     - Rows whose schedule belongs to their own medicine are not (d)'s:
--       their medicine can still be another member's, which (c') and (e)
--       below find.
--     The owner may delete the rows (c) lists instead:
--     `delete from public.medication_doses d where <the same where clause>`.
update public.medication_doses d
   set schedule_id = null
 where d.schedule_id is not null
   and not exists (select 1 from public.medication_schedules s
                    where s.id = d.schedule_id and s.medication_id = d.medication_id
                      and s.family_id = d.family_id);

-- A second shape (d) does not reach: a dose whose schedule IS its medicine's,
-- while the medicine is another member's. A child's own dose moved onto the
-- parent's medicine AND that medicine's schedule by one UPDATE 0481 allowed
-- (medication_doses_update checks only is_self_member(member_id), and 0481's
-- guard was INSERT-only), or a member's genuine dose of a medicine a manager
-- has since given to someone else (saveMed, medications-module.tsx:349-358;
-- a family-wide medicine's dose is written with member_id null, :325-329).
-- Both fail the member clause of the guards above, so the update guard
-- refuses the row to everyone, a manager included, and the screen disables
-- the slot (medications-module.tsx:484-486: the loaded dose's member is not
-- the medicine's). Such a row dated the family's today or later still holds
-- a slot that the medicine's member, or a manager, has to log, and its
-- reminder stays suppressed (lib/server/notifications.ts:200 reads the slot
-- by schedule_id and scheduled_for only). A row dated before that holds no
-- slot anyone can log any more: it is history, planted or not, and only the
-- owner can tell which.
--
-- One row of the live window is NOT freed: a dose marked 'taken' on the
-- family's today. The module logs only today's slots (logDose,
-- medications-module.tsx:291-295), so a 'taken' row in the live window is
-- today's, and it can be a dose genuinely given: a family-wide Vitamin D a
-- manager logged at 08:00 and then gave to the child, or a child's drops a
-- parent then gave to the teen. Freeing its slot lets the medicine's member
-- log that 08:00 'taken' a second time (measured: the child's insert of the
-- same slot got 1), and the screen and the reminder would read the dose as
-- not yet given. Kept, today's slot reads as already logged: the reminder
-- is not sent; a manager's screen shows 'This dose changed' with the slot's
-- buttons disabled (:501-511); the medicine's own non-manager member, who
-- reads only their own doses, sees the slot pending and every tap refused
-- with 23505 ('This dose changed', :237-238). From tomorrow the row is
-- history like any other.
-- A planted 'taken' of today is kept by the same rule, for that one day.
--
-- (c') Report (read-only), to review before (e). unscheduled_by_e is what
--      (e) changes. kept_as_taken_today marks the live rows (e) leaves: a
--      dose marked taken on the family's today. REVIEW THOSE ROWS: a genuine
--      dose stays (the slot is not logged twice); one the owner judges
--      planted, or a dose the medicine's new member has not had, the owner
--      deletes by id (`delete from public.medication_doses where id = '<id>'`),
--      which frees today's slot. The other rows are history, for the owner
--      to judge:
--   with known as materialized (
--     select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs)
--   select d.id, d.family_id, d.medication_id, m.member_id as medicine_is_for,
--          d.member_id, d.schedule_id, d.scheduled_for, d.status, d.logged_by, d.created_at,
--          (d.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date
--            and not (d.status = 'taken' and (d.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date) as unscheduled_by_e,
--          d.status = 'taken' and (d.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date as kept_as_taken_today
--     from public.medication_doses d
--     join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
--     join public.families f on f.id = d.family_id
--     cross join lateral (select coalesce((select k.name from known k where k.name = f.timezone limit 1), 'UTC') as tz) z
--    where d.schedule_id is not null
--      and exists (select 1 from public.medication_schedules s
--                   where s.id = d.schedule_id and s.medication_id = d.medication_id
--                     and s.family_id = d.family_id)
--      and m.member_id is not null and m.member_id is distinct from d.member_id
--    order by d.family_id, d.scheduled_for, d.id;
--
-- (e) One-time repair, re-runnable (a second run matches nothing). It
--     unschedules the rows (c') marks unscheduled_by_e, on the family's own
--     day (an unknown zone counts as UTC, as 0449 records):
--     - the slot is free again, for the medicine's member or a manager to log
--       from the screen, and its reminder comes back;
--     - the row is kept, as an unscheduled dose of that medicine in the name
--       of the member who wrote it. No client can correct it (the member
--       clause still refuses it), and the managers' adherence ring counts it,
--       because windowDoseLogs reads doses by medicine only
--       (medications-module.tsx:278-281).
--     So the owner may delete the rows instead, which suits a planted 'skipped'
--     better and loses a genuine dose's history: the same statement with
--     `delete from public.medication_doses d using candidates c ...` in place
--     of the update (keep the last where line, so a dose taken today stays).
--     A manager's later change of a medicine's 'For' (saveMed,
--     medications-module.tsx:349-358) can leave rows already logged in this
--     shape again. Re-running (e) frees the slots they hold after today, and
--     today's when its row is not 'taken'. A dose taken today keeps today's
--     slot, so it cannot be logged 'taken' a second time; review it in (c')
--     (kept_as_taken_today) and delete it only if the medicine's new member
--     still has that dose to take. To accept the second log instead, drop the
--     last where line of (e) and the matching `and not (...)` line from (c')'s
--     unscheduled_by_e, so that (c') reports what the edited (e) changes.
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs
), candidates as materialized (
  select d.id, d.scheduled_for, d.status, f.timezone
    from public.medication_doses d
    join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
    join public.families f on f.id = d.family_id
   where d.schedule_id is not null
     and exists (select 1 from public.medication_schedules s
                  where s.id = d.schedule_id and s.medication_id = d.medication_id
                    and s.family_id = d.family_id)
     and m.member_id is not null and m.member_id is distinct from d.member_id
)
update public.medication_doses d
   set schedule_id = null
  from candidates c
  cross join lateral (select coalesce((select k.name from known k where k.name = c.timezone limit 1), 'UTC') as tz) z
 where d.id = c.id
   and (c.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date
   and not (c.status = 'taken' and (c.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date);
```

### PROBE (OA1-e/taken-today gate, self-contained): rv-oa1-e-edges-r4.sql

```sql
-- PROBE OA1-e/taken-today (round 4; the reviewer's rv-oa1-e-edges.sql with
-- owner action #1 r4's (e) and its observations made assertions). Owner
-- action #1 (e) on the family's own day, in three zones and an unknown one,
-- plus the family-wide-then-reassigned shape (a manager's member-null dose of
-- today, taken). Runs (e) twice; the second run must change nothing. It runs
-- (e) itself, so it needs no owner action applied first. Rolled back.
\set ON_ERROR_STOP on
begin;
create temp table z_fam (k text primary key, fam uuid, tz text, mP uuid, mK uuid, medP uuid, schP uuid);
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000e0001', 'rv-e-parent@example.test'), ('00000000-0000-4000-8000-0000000e0002', 'rv-e-child@example.test');
do $fx$
declare r record; i int := 0; f uuid; mp uuid; mk uuid; mdp uuid; sp uuid;
begin
  for r in select * from (values ('LA','America/Los_Angeles'), ('KI','Pacific/Kiritimati'), ('UTC','UTC'), ('XX','Mars/Olympus')) v(k, tz) loop
    i := i + 1;
    f := ('00000000-0000-4000-8000-0000000e0f0' || i)::uuid;
    mp := ('00000000-0000-4000-8000-0000000e0a' || i || '1')::uuid; mk := ('00000000-0000-4000-8000-0000000e0a' || i || '2')::uuid;
    mdp := ('00000000-0000-4000-8000-0000000e0b0' || i)::uuid; sp := ('00000000-0000-4000-8000-0000000e0c0' || i)::uuid;
    if r.k = 'XX' then set local session_replication_role = replica; end if;
    insert into public.families (id, name, timezone) values (f, 'rv-e ' || r.k, r.tz);
    if r.k = 'XX' then set local session_replication_role = origin; end if;
    insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
      (mp, f, case when r.k = 'UTC' then '00000000-0000-4000-8000-0000000e0001'::uuid end, 'P', 'parent', true),
      (mk, f, case when r.k = 'UTC' then '00000000-0000-4000-8000-0000000e0002'::uuid end, 'K', 'child', true);
    insert into public.medications (id, family_id, member_id, name) values (mdp, f, mp, 'P med');
    insert into public.medication_schedules (id, family_id, medication_id, time_of_day) values (sp, f, mdp, '08:00');
    insert into z_fam values (r.k, f, r.tz, mp, mk, mdp, sp);
  end loop;
end $fx$;
-- Legacy rows: the child's dose on the parent's medicine AND its schedule, at
-- local times. 'skipped' rows stand for planted squats; 'taken' rows for a dose
-- marked taken (genuine or planted, which only the owner can tell).
create temp table z_dose (label text, id uuid, fam_k text, status text, want_scheduled boolean);
insert into z_dose
select z.k || ' ' || v.label, gen_random_uuid(), z.k, v.status, v.want from z_fam z,
  (values ('local yesterday 23:00 skipped', 'skipped', true), ('local today 00:30 skipped', 'skipped', false),
          ('local today 23:30 skipped', 'skipped', false), ('local tomorrow 08:00 skipped', 'skipped', false),
          ('local yesterday 22:00 taken', 'taken', true), ('local today 00:45 taken', 'taken', true),
          ('local today 23:15 taken', 'taken', true), ('local tomorrow 00:30 taken', 'taken', false)) v(label, status, want);
insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status)
select d.id, z.fam, z.medP, z.schP, z.mK,
       (case split_part(d.label, ' ', 3)
          when 'yesterday' then ((now() at time zone eff.tz)::date - 1) + (split_part(d.label, ' ', 4))::time
          when 'today' then ((now() at time zone eff.tz)::date) + (split_part(d.label, ' ', 4))::time
          else ((now() at time zone eff.tz)::date + 1) + (split_part(d.label, ' ', 4))::time end) at time zone eff.tz,
       d.status::public.dose_status
  from z_dose d join z_fam z on z.k = d.fam_k
  cross join lateral (select case when z.tz = 'Mars/Olympus' then 'UTC' else z.tz end as tz) eff;
-- The family-wide-then-reassigned shape, in the UTC family: a manager's dose of
-- today, taken, with member_id null on a family-wide medicine (as
-- medications-module.tsx:325-329 sends it), which a manager then gives to the
-- child (saveMed, :349-358).
insert into public.medications (id, family_id, member_id, name) select '00000000-0000-4000-8000-0000000e0bfa', fam, null, 'Vitamin D' from z_fam where k = 'UTC';
insert into public.medication_schedules (id, family_id, medication_id, time_of_day) select '00000000-0000-4000-8000-0000000e0cfa', fam, '00000000-0000-4000-8000-0000000e0bfa', '08:00' from z_fam where k = 'UTC';
insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
select '00000000-0000-4000-8000-0000000e0dfa', fam, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', null, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0001' from z_fam where k = 'UTC';
update public.medications set member_id = (select mK from z_fam where k = 'UTC') where id = '00000000-0000-4000-8000-0000000e0bfa';
select 'zone now', z.k, (now() at time zone (case when z.tz = 'Mars/Olympus' then 'UTC' else z.tz end))::date as local_today, (now() at time zone 'UTC')::date as utc_today from z_fam z order by 1, 2;
-- (e), verbatim from owner action #1 r4, first run:
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs
), candidates as materialized (
  select d.id, d.scheduled_for, d.status, f.timezone
    from public.medication_doses d
    join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
    join public.families f on f.id = d.family_id
   where d.schedule_id is not null
     and exists (select 1 from public.medication_schedules s
                  where s.id = d.schedule_id and s.medication_id = d.medication_id
                    and s.family_id = d.family_id)
     and m.member_id is not null and m.member_id is distinct from d.member_id
)
update public.medication_doses d
   set schedule_id = null
  from candidates c
  cross join lateral (select coalesce((select k.name from known k where k.name = c.timezone limit 1), 'UTC') as tz) z
 where d.id = c.id
   and (c.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date
   and not (c.status = 'taken' and (c.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date);
-- (e) second run:
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs
), candidates as materialized (
  select d.id, d.scheduled_for, d.status, f.timezone
    from public.medication_doses d
    join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
    join public.families f on f.id = d.family_id
   where d.schedule_id is not null
     and exists (select 1 from public.medication_schedules s
                  where s.id = d.schedule_id and s.medication_id = d.medication_id
                    and s.family_id = d.family_id)
     and m.member_id is not null and m.member_id is distinct from d.member_id
)
update public.medication_doses d
   set schedule_id = null
  from candidates c
  cross join lateral (select coalesce((select k.name from known k where k.name = c.timezone limit 1), 'UTC') as tz) z
 where d.id = c.id
   and (c.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date
   and not (c.status = 'taken' and (c.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date);
create temp table p_result (seq serial, label text, want text, got text, ok boolean);
do $a$
declare r record;
begin
  for r in select d.label, d.want_scheduled, md.schedule_id is not null as scheduled, md.scheduled_for from z_dose d join public.medication_doses md on md.id = d.id order by d.label loop
    insert into p_result (label, want, got, ok) values (r.label || ' (' || r.scheduled_for || ')', case when r.want_scheduled then 'kept' else 'unscheduled' end,
      case when r.scheduled then 'kept' else 'unscheduled' end, r.scheduled = r.want_scheduled);
  end loop;
  insert into p_result (label, want, got, ok)
  select 'family-wide->child: the manager''s member-null 08:00 dose of today (taken) keeps today''s slot after (e)', 'kept',
         case when schedule_id is null then 'unscheduled' else 'kept' end, schedule_id is not null
    from public.medication_doses where id = '00000000-0000-4000-8000-0000000e0dfa';
end $a$;
do $b$
declare n text; res text; vf uuid; vk uuid;
begin
  select fam, mK into vf, vk from pg_temp.z_fam where k = 'UTC';
  -- the child now logs today's 08:00 of the Vitamin D (their medicine now), as medications-module.tsx:325-329 sends it
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000e0002', 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000e0002', true);
  execute 'set local role authenticated';
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
    values (vf, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', vk, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0002');
    get diagnostics n = row_count; res := n;
  exception when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into p_result (label, want, got, ok) values ('family-wide->child: the child cannot log the same 08:00 of today ''taken'' a second time', 'error:23505', res, res like 'error:23505%');
  -- control: tomorrow's 08:00 of the Vitamin D is the child's to log
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000e0002', 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000e0002', true);
  execute 'set local role authenticated';
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
    values (vf, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', vk, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 day 8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0002');
    get diagnostics n = row_count; res := n;
  exception when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into p_result (label, want, got, ok) values ('family-wide->child: control, the child logs tomorrow''s 08:00 of the Vitamin D', '1', res, res = '1');
end $b$;
do $v$
declare r record; bad int;
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
  end loop;
  select count(*) into bad from p_result where not ok;
  raise notice 'reviewer verdict: % of % held', (select count(*) from p_result) - bad, (select count(*) from p_result);
end $v$;
rollback;
```

### PROBE SEED, committed before #1: seed-oa1-planted-r3.sql

```sql
-- SEED for the OA1-no-repair probe (round 3). COMMITTED on purpose: it stands
-- for dose rows written before owner action #1 exists, the way 0481 let them
-- be written, by the members' own sessions. Run once, before owner action #1.
-- Fixed ids (…0009a…) so probe-oa1-repair-r3.sql can find them. Round 3 adds
-- the shape repair (d) does not reach (a dose moved onto another member's
-- medicine AND its schedule), in two days and four days ago, and a genuine
-- dose of today on a medicine a parent then gave to the teen.
\set ON_ERROR_STOP on
begin;
create function pg_temp.as_member(who uuid, q text) returns int language plpgsql as $f$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q;
  get diagnostics n = row_count;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return n;
end $f$;
do $seed$
declare
  fam uuid := '00000000-0000-4000-8000-00000009a000';
  uP uuid := '00000000-0000-4000-8000-00000009a001';
  uK uuid := '00000000-0000-4000-8000-00000009a004';
  uT uuid := '00000000-0000-4000-8000-00000009a003';
  mP uuid := '00000000-0000-4000-8000-00000009a0a1';
  mK uuid := '00000000-0000-4000-8000-00000009a0a4';
  mT uuid := '00000000-0000-4000-8000-00000009a0a3';
  medP uuid := '00000000-0000-4000-8000-00000009a0b1';
  medK uuid := '00000000-0000-4000-8000-00000009a0b4';
  medR uuid := '00000000-0000-4000-8000-00000009a0b5';
  schP uuid := '00000000-0000-4000-8000-00000009a0c1';
  schK uuid := '00000000-0000-4000-8000-00000009a0c4';
  schR uuid := '00000000-0000-4000-8000-00000009a0c5';
  dSquat uuid := '00000000-0000-4000-8000-00000009a0d1';  -- K's medicine on P's schedule (INSERT)
  dMoved uuid := '00000000-0000-4000-8000-00000009a0d2';  -- K's own dose, moved onto P's schedule (UPDATE)
  dOwn uuid := '00000000-0000-4000-8000-00000009a0d3';    -- K's genuine dose of their own medicine
  dReassigned uuid := '00000000-0000-4000-8000-00000009a0d4'; -- K's genuine dose of medR, which a parent then gave to T
  medR2 uuid := '00000000-0000-4000-8000-00000009a0b6';
  schR2 uuid := '00000000-0000-4000-8000-00000009a0c6';
  dV uuid := '00000000-0000-4000-8000-00000009a0d5';      -- K's own dose moved onto P's medicine AND schedule, in 2 days (UPDATE)
  dVpast uuid := '00000000-0000-4000-8000-00000009a0d6';  -- the same move, onto 4 days ago
  dToday uuid := '00000000-0000-4000-8000-00000009a0d7';  -- K's genuine dose of medR2 today, which a parent then gave to T
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
  n int;
begin
  insert into auth.users (id, email) values (uP, 'oa1r-parent@example.test'), (uK, 'oa1r-child@example.test'), (uT, 'oa1r-teen@example.test');
  insert into public.families (id, name, timezone) values (fam, 'OA1 repair', 'UTC');
  insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
    (mP, fam, uP, 'Parent', 'parent', true), (mK, fam, uK, 'Kid', 'child', true), (mT, fam, uT, 'Teen', 'teen', true);
  insert into public.medications (id, family_id, member_id, name, created_by) values
    (medP, fam, mP, 'Parent statin', uP), (medK, fam, mK, 'Kid syrup', uP), (medR, fam, mK, 'Inhaler', uP),
    (medR2, fam, mK, 'Allergy drops', uP);
  insert into public.medication_schedules (id, family_id, medication_id, time_of_day) values
    (schP, fam, medP, '08:00'), (schK, fam, medK, '08:00'), (schR, fam, medR, '08:00'), (schR2, fam, medR2, '08:00');
  -- As the child, the way 0481 allowed: a dose of their own medicine on the parent's slot ...
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dSquat, fam, medK, schP, mK, slot, uK));
  if n <> 1 then raise exception 'seed: the squatting insert did not land (%)', n; end if;
  -- ... and their own dose of yesterday moved onto the parent's slot tomorrow.
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dMoved, fam, medK, schK, mK, slot - interval '1 day', uK));
  n := pg_temp.as_member(uK, format('update public.medication_doses set schedule_id = %L, scheduled_for = %L where id = %L', schP, slot + interval '1 day', dMoved));
  if n <> 1 then raise exception 'seed: the moving update did not land (%)', n; end if;
  -- Genuine history that must not be touched.
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dOwn, fam, medK, schK, mK, slot - interval '2 days', uK));
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dReassigned, fam, medR, schR, mK, slot - interval '2 days', uK));
  n := pg_temp.as_member(uP, format('update public.medications set member_id = %L where id = %L', mT, medR));
  if n <> 1 then raise exception 'seed: the reassignment did not land (%)', n; end if;
  -- Round 3: the child's own dose moved, by one UPDATE, onto the parent's
  -- medicine AND that medicine's schedule (the reviewer's variant), in 2 days.
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dV, fam, medK, schK, mK, slot - interval '3 days', uK));
  n := pg_temp.as_member(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L, scheduled_for = %L, status = ''skipped'' where id = %L', medP, schP, slot + interval '2 days', dV));
  raise notice 'seed: the child''s UPDATE moving their dose onto the parent''s medicine and schedule (in 2 days) returned %', n;
  if n <> 1 then raise exception 'seed: the variant move did not land (%)', n; end if;
  -- The same move onto a day already past.
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dVpast, fam, medK, schK, mK, slot - interval '5 days', uK));
  n := pg_temp.as_member(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L, scheduled_for = %L, status = ''skipped'' where id = %L', medP, schP, slot - interval '4 days', dVpast));
  raise notice 'seed: the same move onto 4 days ago returned %', n;
  if n <> 1 then raise exception 'seed: the past variant move did not land (%)', n; end if;
  -- Genuine: the child logs today's drops, then a parent gives the drops to the teen.
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dToday, fam, medR2, schR2, mK, slot, uK));
  n := pg_temp.as_member(uP, format('update public.medications set member_id = %L where id = %L', mT, medR2));
  if n <> 1 then raise exception 'seed: the second reassignment did not land (%)', n; end if;
end
$seed$;
commit;
```

### PROBE: probe-oa1-repair-r4.sql

```sql
-- PROBE OA1-no-repair (round 4). Needs seed-oa1-planted-r3.sql (committed
-- before owner action #1). Asserts what owner action #1, with its repairs
-- (c)/(d) and (c')/(e), leaves:
-- the slots the child's planted rows held are the parent's to log again, the
-- planted rows are kept as unscheduled doses of their own medicine that a
-- manager can correct, genuine history is untouched, a dose taken today keeps
-- today's slot (OA1-e/taken-today: it is not logged 'taken' twice), and the
-- guard still refuses a new squat. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q;
    get diagnostics n = row_count;
    res := n::text;
  exception
    when insufficient_privilege then res := 'refused';
    when unique_violation then res := 'unique';
    when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009a000';
  uP uuid := '00000000-0000-4000-8000-00000009a001';
  uK uuid := '00000000-0000-4000-8000-00000009a004';
  mP uuid := '00000000-0000-4000-8000-00000009a0a1';
  mK uuid := '00000000-0000-4000-8000-00000009a0a4';
  medP uuid := '00000000-0000-4000-8000-00000009a0b1';
  medK uuid := '00000000-0000-4000-8000-00000009a0b4';
  schP uuid := '00000000-0000-4000-8000-00000009a0c1';
  schK uuid := '00000000-0000-4000-8000-00000009a0c4';
  schR uuid := '00000000-0000-4000-8000-00000009a0c5';
  dSquat uuid := '00000000-0000-4000-8000-00000009a0d1';
  dMoved uuid := '00000000-0000-4000-8000-00000009a0d2';
  dOwn uuid := '00000000-0000-4000-8000-00000009a0d3';
  dReassigned uuid := '00000000-0000-4000-8000-00000009a0d4';
  uT uuid := '00000000-0000-4000-8000-00000009a003';
  mT uuid := '00000000-0000-4000-8000-00000009a0a3';
  medR2 uuid := '00000000-0000-4000-8000-00000009a0b6';
  schR2 uuid := '00000000-0000-4000-8000-00000009a0c6';
  dV uuid := '00000000-0000-4000-8000-00000009a0d5';
  dVpast uuid := '00000000-0000-4000-8000-00000009a0d6';
  dToday uuid := '00000000-0000-4000-8000-00000009a0d7';
  dLater uuid := '00000000-0000-4000-8000-00000009a0d8';
  slot timestamptz;
  ins text := 'insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  select scheduled_for into slot from public.medication_doses where id = dSquat;
  if slot is null then raise exception 'probe fixture: seed-oa1-planted-r3.sql has not been run'; end if;
  if not exists (select 1 from public.medication_doses where id = dV) then raise exception 'probe fixture: the round-3 rows of seed-oa1-planted-r3.sql are missing'; end if;
  perform pg_temp.p_expect('the report (c) finds no dose naming another medicine''s schedule',
    (select count(*)::text from public.medication_doses d
      where d.schedule_id is not null
        and not exists (select 1 from public.medication_schedules s
                         where s.id = d.schedule_id and s.medication_id = d.medication_id and s.family_id = d.family_id)
        and d.family_id = fam), '0');
  perform pg_temp.p_expect('the planted INSERT is kept as an unscheduled dose of the child''s own medicine',
    (select count(*)::text from public.medication_doses where id = dSquat and schedule_id is null and medication_id = medK and member_id = mK and status = 'taken'), '1');
  perform pg_temp.p_expect('the planted UPDATE move is kept as an unscheduled dose of the child''s own medicine',
    (select count(*)::text from public.medication_doses where id = dMoved and schedule_id is null and medication_id = medK and member_id = mK), '1');
  perform pg_temp.p_expect('the parent logs their own 08:00 today, the slot the child held (medications-module.tsx:325)',
    pg_temp.p_try(uP, format(ins, fam, medP, schP, mP, slot, 'taken', uP)), 'ok');
  perform pg_temp.p_expect('the parent logs their own 08:00 tomorrow, the slot the child moved a dose onto',
    pg_temp.p_try(uP, format(ins, fam, medP, schP, mP, slot + interval '1 day', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('a parent corrects the repaired row (the update guard admits it again)',
    pg_temp.p_try(uP, format('update public.medication_doses set status = ''skipped'', taken_at = null where id = %L', dSquat)), 'ok');
  perform pg_temp.p_expect('the child''s genuine dose of their own medicine keeps its schedule',
    (select count(*)::text from public.medication_doses where id = dOwn and schedule_id = schK), '1');
  perform pg_temp.p_expect('the child''s genuine dose of a medicine since given to the teen keeps its schedule (not the repair''s to touch)',
    (select count(*)::text from public.medication_doses where id = dReassigned and schedule_id = schR and member_id = mK), '1');
  perform pg_temp.p_expect('the guard still refuses the child a new squat on the parent''s slot',
    pg_temp.p_try(uK, format(ins, fam, medK, schP, mK, slot + interval '3 days', 'taken', uK)), 'refused');
  -- Round 3 (OA1-no-repair): a dose on another member's medicine AND its schedule.
  perform pg_temp.p_expect('the report (c'') marks no row (e) unschedules: a scheduled dose on its medicine''s own schedule whose member is not the medicine''s, holding a live slot, and not taken today',
    (select count(*)::text from public.medication_doses d
       join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
      where d.family_id = fam and d.schedule_id is not null
        and exists (select 1 from public.medication_schedules s where s.id = d.schedule_id and s.medication_id = d.medication_id and s.family_id = d.family_id)
        and m.member_id is not null and m.member_id is distinct from d.member_id
        and (d.scheduled_for at time zone 'UTC')::date >= (now() at time zone 'UTC')::date
        and not (d.status = 'taken' and (d.scheduled_for at time zone 'UTC')::date = (now() at time zone 'UTC')::date)), '0');
  perform pg_temp.p_expect('the report (c'') marks exactly the dose taken today as kept_as_taken_today',
    (select string_agg(case d.id when dToday then 'taken today' else d.id::text end, ', ' order by d.scheduled_for, d.id)
       from public.medication_doses d
       join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
      where d.family_id = fam and d.schedule_id is not null
        and exists (select 1 from public.medication_schedules s where s.id = d.schedule_id and s.medication_id = d.medication_id and s.family_id = d.family_id)
        and m.member_id is not null and m.member_id is distinct from d.member_id
        and d.status = 'taken' and (d.scheduled_for at time zone 'UTC')::date = (now() at time zone 'UTC')::date), 'taken today');
  perform pg_temp.p_expect('the report (c'') still lists the two past rows and the dose taken today for the owner to judge',
    (select string_agg(case d.id when dVpast then 'past move' when dReassigned then 'genuine reassigned' when dToday then 'taken today' else d.id::text end, ', ' order by d.scheduled_for, d.id)
       from public.medication_doses d
       join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
      where d.family_id = fam and d.schedule_id is not null
        and exists (select 1 from public.medication_schedules s where s.id = d.schedule_id and s.medication_id = d.medication_id and s.family_id = d.family_id)
        and m.member_id is not null and m.member_id is distinct from d.member_id), 'past move, genuine reassigned, taken today');
  perform pg_temp.p_expect('the child''s dose moved onto the parent''s medicine and schedule in 2 days is kept, unscheduled',
    (select count(*)::text from public.medication_doses where id = dV and schedule_id is null and medication_id = medP and member_id = mK and status = 'skipped'), '1');
  perform pg_temp.p_expect('the parent logs their own 08:00 in 2 days, the slot that row held (medications-module.tsx:325-329)',
    pg_temp.p_try(uP, format(ins, fam, medP, schP, mP, slot + interval '2 days', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('the same move onto 4 days ago keeps its schedule (a past slot; (c'') reports it)',
    (select count(*)::text from public.medication_doses where id = dVpast and schedule_id = schP and medication_id = medP and member_id = mK), '1');
  perform pg_temp.p_expect('the child''s genuine dose taken today, on drops since given to the teen, keeps today''s slot (OA1-e/taken-today)',
    (select count(*)::text from public.medication_doses where id = dToday and schedule_id = schR2 and medication_id = medR2 and member_id = mK and status = 'taken'), '1');
  perform pg_temp.p_expect('the teen cannot log today''s 08:00 of the drops ''taken'' a second time (sent as medications-module.tsx:325-329 sends it)',
    pg_temp.p_try(uT, format(ins, fam, medR2, schR2, mT, slot, 'taken', uT)), 'unique');
  perform pg_temp.p_expect('the teen logs tomorrow''s 08:00 of the drops now theirs (the kept row holds today only)',
    pg_temp.p_try(uT, format(ins, fam, medR2, schR2, mT, slot + interval '1 day', 'taken', uT)), 'ok');
  perform pg_temp.p_expect('the child logs a dose of their own medicine (a control for the move below)',
    pg_temp.p_try(uK, format('insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, ''taken'', %L)', dLater, fam, medK, schK, mK, slot + interval '5 days', uK)), 'ok');
  perform pg_temp.p_expect('the update guard refuses the child moving that dose onto the parent''s medicine and schedule',
    pg_temp.p_try(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L, scheduled_for = %L where id = %L', medP, schP, slot + interval '6 days', dLater)), 'refused');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe OA1 repair: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe OA1 repair: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (round 1, unchanged): probe-n1-n3.sql

```sql
-- PROBE N1/N2/N3: a dose names its own medicine's schedule (insert AND update),
-- a guest logs no dose and writes no care note. Rolled back.
\set ON_ERROR_STOP on
begin;

create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' end);
end $f$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000006d000';
  uP uuid := '00000000-0000-4000-8000-00000006d001';
  uT uuid := '00000000-0000-4000-8000-00000006d002';
  uK uuid := '00000000-0000-4000-8000-00000006d003';
  uC uuid := '00000000-0000-4000-8000-00000006d004';
  uG uuid := '00000000-0000-4000-8000-00000006d005';
  mP uuid; mT uuid; mK uuid; mC uuid; mG uuid;
  medP uuid; medT uuid; medK uuid; medF uuid; medC uuid;
  schP uuid; schT uuid; schK uuid; schF uuid; schC uuid;
  doseK uuid;
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
  ins text := 'insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, %L)';
  care text := 'insert into public.care_log (family_id, member_id, log_type, wellbeing, note, logged_by, created_by) values (%L, %L, %L, %s, %L, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n1-parent@example.test'), (uT, 'n1-teen@example.test'),
    (uK, 'n1-child@example.test'), (uC, 'n1-carer@example.test'), (uG, 'n1-guest@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, timezone) values (fam, 'N1 probe', 'UTC') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Parent', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Grandma', 'guest', true) returning id into mG;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mP, 'Parent insulin', uP) returning id into medP;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mT, 'Teen inhaler', uP) returning id into medT;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mK, 'Kid syrup', uP) returning id into medK;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, null, 'Family vitamin', uP) returning id into medF;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mC, 'Sitter allergy', uP) returning id into medC;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medP, '08:00') returning id into schP;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medT, '08:00') returning id into schT;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medK, '08:00') returning id into schK;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medF, '08:00') returning id into schF;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medC, '08:00') returning id into schC;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, schK, mK, slot, 'taken', uK) returning id into doseK;

  -- N1 (A1, A2): a dose in another member's schedule slot
  perform pg_temp.p_expect('N1 A1: child logs their own medicine into the parent''s insulin slot',
    pg_temp.p_try(uK, format(ins, fam, medK, schP, mK, slot, 'taken', uK)), 'refused');
  perform pg_temp.p_expect('N1 A1: teen logs their own medicine into the child''s slot',
    pg_temp.p_try(uT, format(ins, fam, medT, schK, mT, slot - interval '1 day', 'skipped', uT)), 'refused');
  perform pg_temp.p_expect('N1 A2: guest logs the family-wide medicine into the teen''s slot',
    pg_temp.p_try(uG, format(ins, fam, medF, schT, mG, slot, 'taken', uG)), 'refused');
  perform pg_temp.p_expect('N1 A2: caregiver logs the family-wide medicine into the parent''s slot',
    pg_temp.p_try(uC, format(ins, fam, medF, schP, mC, slot, 'skipped', uC)), 'refused');
  perform pg_temp.p_expect('N1 guest: guest logs the family-wide medicine on its own schedule',
    pg_temp.p_try(uG, format(ins, fam, medF, schF, mG, slot, 'taken', uG)), 'refused');
  -- N2: the same move, by rewriting one's own dose
  perform pg_temp.p_expect('N2: child moves their own dose onto the teen''s medicine and slot',
    pg_temp.p_try(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L where id = %L', medT, schT, doseK)), 'refused');
  perform pg_temp.p_expect('N2: child moves their own dose into the parent''s slot',
    pg_temp.p_try(uK, format('update public.medication_doses set schedule_id = %L where id = %L', schP, doseK)), 'refused');
  -- N3: a guest's care note
  perform pg_temp.p_expect('N3: guest writes an incident about the child',
    pg_temp.p_try(uG, format(care, fam, mK, 'incident', '1', 'Fell, hit head', mG, uG)), 'refused');
  perform pg_temp.p_expect('N3: guest writes a medication note about the child',
    pg_temp.p_try(uG, format(care, fam, mK, 'medication', 'null', 'Gave 10ml', null, uG)), 'refused');

  -- what still lands
  perform pg_temp.p_expect('child logs their own medicine on its own schedule',
    pg_temp.p_try(uK, format(ins, fam, medK, schK, mK, slot - interval '1 day', 'taken', uK)), 'ok');
  perform pg_temp.p_expect('child marks their own dose skipped (status only, what the module sends)',
    pg_temp.p_try(uK, format('update public.medication_doses set status = ''skipped'', taken_at = null where id = %L', doseK)), 'ok');
  perform pg_temp.p_expect('parent logs their insulin on its schedule',
    pg_temp.p_try(uP, format(ins, fam, medP, schP, mP, slot, 'taken', uP)), 'ok');
  perform pg_temp.p_expect('parent logs the child''s medicine',
    pg_temp.p_try(uP, format(ins, fam, medK, schK, mK, slot - interval '2 days', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('parent logs a dose with no schedule (as-needed)',
    pg_temp.p_try(uP, format(ins, fam, medK, null, mK, slot - interval '3 hours', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('caregiver logs the family-wide medicine on its own schedule in their own name (0481 FIX 1)',
    pg_temp.p_try(uC, format(ins, fam, medF, schF, mC, slot, 'taken', uC)), 'ok');
  perform pg_temp.p_expect('caregiver logs their own medicine',
    pg_temp.p_try(uC, format(ins, fam, medC, schC, mC, slot, 'taken', uC)), 'ok');
  perform pg_temp.p_expect('parent corrects the child''s dose',
    pg_temp.p_try(uP, format('update public.medication_doses set status = ''skipped'' where id = %L', doseK)), 'ok');
  perform pg_temp.p_expect('caregiver writes a care note about the child',
    pg_temp.p_try(uC, format(care, fam, mK, 'medication', 'null', 'Gave 5ml', mC, uC)), 'ok');
  perform pg_temp.p_expect('parent writes a care note',
    pg_temp.p_try(uP, format(care, fam, mK, 'check_in', '4', 'Fine', mP, uP)), 'ok');
end
$probe$;

do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N1-N3: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N1-N3: % assertions held', (select count(*) from p_result);
end
$verdict$;

rollback;
```

### PROBE, the before variant run with round 3 (e): rv-oa1-e-edges-r4-with-r3e.sql

```sql
-- PROBE OA1-e/taken-today (round 4; the reviewer's rv-oa1-e-edges.sql with
-- owner action #1 r4's (e) and its observations made assertions). Owner
-- action #1 (e) on the family's own day, in three zones and an unknown one,
-- plus the family-wide-then-reassigned shape (a manager's member-null dose of
-- today, taken). Runs (e) twice; the second run must change nothing. Needs
-- owner action #1's guards applied first. Rolled back.
\set ON_ERROR_STOP on
begin;
create temp table z_fam (k text primary key, fam uuid, tz text, mP uuid, mK uuid, medP uuid, schP uuid);
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000e0001', 'rv-e-parent@example.test'), ('00000000-0000-4000-8000-0000000e0002', 'rv-e-child@example.test');
do $fx$
declare r record; i int := 0; f uuid; mp uuid; mk uuid; mdp uuid; sp uuid;
begin
  for r in select * from (values ('LA','America/Los_Angeles'), ('KI','Pacific/Kiritimati'), ('UTC','UTC'), ('XX','Mars/Olympus')) v(k, tz) loop
    i := i + 1;
    f := ('00000000-0000-4000-8000-0000000e0f0' || i)::uuid;
    mp := ('00000000-0000-4000-8000-0000000e0a' || i || '1')::uuid; mk := ('00000000-0000-4000-8000-0000000e0a' || i || '2')::uuid;
    mdp := ('00000000-0000-4000-8000-0000000e0b0' || i)::uuid; sp := ('00000000-0000-4000-8000-0000000e0c0' || i)::uuid;
    if r.k = 'XX' then set local session_replication_role = replica; end if;
    insert into public.families (id, name, timezone) values (f, 'rv-e ' || r.k, r.tz);
    if r.k = 'XX' then set local session_replication_role = origin; end if;
    insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
      (mp, f, case when r.k = 'UTC' then '00000000-0000-4000-8000-0000000e0001'::uuid end, 'P', 'parent', true),
      (mk, f, case when r.k = 'UTC' then '00000000-0000-4000-8000-0000000e0002'::uuid end, 'K', 'child', true);
    insert into public.medications (id, family_id, member_id, name) values (mdp, f, mp, 'P med');
    insert into public.medication_schedules (id, family_id, medication_id, time_of_day) values (sp, f, mdp, '08:00');
    insert into z_fam values (r.k, f, r.tz, mp, mk, mdp, sp);
  end loop;
end $fx$;
-- Legacy rows: the child's dose on the parent's medicine AND its schedule, at
-- local times. 'skipped' rows stand for planted squats; 'taken' rows for a dose
-- marked taken (genuine or planted, which only the owner can tell).
create temp table z_dose (label text, id uuid, fam_k text, status text, want_scheduled boolean);
insert into z_dose
select z.k || ' ' || v.label, gen_random_uuid(), z.k, v.status, v.want from z_fam z,
  (values ('local yesterday 23:00 skipped', 'skipped', true), ('local today 00:30 skipped', 'skipped', false),
          ('local today 23:30 skipped', 'skipped', false), ('local tomorrow 08:00 skipped', 'skipped', false),
          ('local yesterday 22:00 taken', 'taken', true), ('local today 00:45 taken', 'taken', true),
          ('local today 23:15 taken', 'taken', true), ('local tomorrow 00:30 taken', 'taken', false)) v(label, status, want);
insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status)
select d.id, z.fam, z.medP, z.schP, z.mK,
       (case split_part(d.label, ' ', 3)
          when 'yesterday' then ((now() at time zone eff.tz)::date - 1) + (split_part(d.label, ' ', 4))::time
          when 'today' then ((now() at time zone eff.tz)::date) + (split_part(d.label, ' ', 4))::time
          else ((now() at time zone eff.tz)::date + 1) + (split_part(d.label, ' ', 4))::time end) at time zone eff.tz,
       d.status::public.dose_status
  from z_dose d join z_fam z on z.k = d.fam_k
  cross join lateral (select case when z.tz = 'Mars/Olympus' then 'UTC' else z.tz end as tz) eff;
-- The family-wide-then-reassigned shape, in the UTC family: a manager's dose of
-- today, taken, with member_id null on a family-wide medicine (as
-- medications-module.tsx:325-329 sends it), which a manager then gives to the
-- child (saveMed, :349-358).
insert into public.medications (id, family_id, member_id, name) select '00000000-0000-4000-8000-0000000e0bfa', fam, null, 'Vitamin D' from z_fam where k = 'UTC';
insert into public.medication_schedules (id, family_id, medication_id, time_of_day) select '00000000-0000-4000-8000-0000000e0cfa', fam, '00000000-0000-4000-8000-0000000e0bfa', '08:00' from z_fam where k = 'UTC';
insert into public.medication_doses (id, family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
select '00000000-0000-4000-8000-0000000e0dfa', fam, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', null, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0001' from z_fam where k = 'UTC';
update public.medications set member_id = (select mK from z_fam where k = 'UTC') where id = '00000000-0000-4000-8000-0000000e0bfa';
select 'zone now', z.k, (now() at time zone (case when z.tz = 'Mars/Olympus' then 'UTC' else z.tz end))::date as local_today, (now() at time zone 'UTC')::date as utc_today from z_fam z order by 1, 2;
-- (e), verbatim from owner action #1 r3 (BEFORE round 4), first run:
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs
), candidates as materialized (
  select d.id, d.scheduled_for, d.status, f.timezone
    from public.medication_doses d
    join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
    join public.families f on f.id = d.family_id
   where d.schedule_id is not null
     and exists (select 1 from public.medication_schedules s
                  where s.id = d.schedule_id and s.medication_id = d.medication_id
                    and s.family_id = d.family_id)
     and m.member_id is not null and m.member_id is distinct from d.member_id
)
update public.medication_doses d
   set schedule_id = null
  from candidates c
  cross join lateral (select coalesce((select k.name from known k where k.name = c.timezone limit 1), 'UTC') as tz) z
 where d.id = c.id
   and (c.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date;
-- (e) second run:
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs
), candidates as materialized (
  select d.id, d.scheduled_for, d.status, f.timezone
    from public.medication_doses d
    join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
    join public.families f on f.id = d.family_id
   where d.schedule_id is not null
     and exists (select 1 from public.medication_schedules s
                  where s.id = d.schedule_id and s.medication_id = d.medication_id
                    and s.family_id = d.family_id)
     and m.member_id is not null and m.member_id is distinct from d.member_id
)
update public.medication_doses d
   set schedule_id = null
  from candidates c
  cross join lateral (select coalesce((select k.name from known k where k.name = c.timezone limit 1), 'UTC') as tz) z
 where d.id = c.id
   and (c.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date;
create temp table p_result (seq serial, label text, want text, got text, ok boolean);
do $a$
declare r record;
begin
  for r in select d.label, d.want_scheduled, md.schedule_id is not null as scheduled, md.scheduled_for from z_dose d join public.medication_doses md on md.id = d.id order by d.label loop
    insert into p_result (label, want, got, ok) values (r.label || ' (' || r.scheduled_for || ')', case when r.want_scheduled then 'kept' else 'unscheduled' end,
      case when r.scheduled then 'kept' else 'unscheduled' end, r.scheduled = r.want_scheduled);
  end loop;
  insert into p_result (label, want, got, ok)
  select 'family-wide->child: the manager''s member-null 08:00 dose of today (taken) keeps today''s slot after (e)', 'kept',
         case when schedule_id is null then 'unscheduled' else 'kept' end, schedule_id is not null
    from public.medication_doses where id = '00000000-0000-4000-8000-0000000e0dfa';
end $a$;
do $b$
declare n text; res text; vf uuid; vk uuid;
begin
  select fam, mK into vf, vk from pg_temp.z_fam where k = 'UTC';
  -- the child now logs today's 08:00 of the Vitamin D (their medicine now), as medications-module.tsx:325-329 sends it
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000e0002', 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000e0002', true);
  execute 'set local role authenticated';
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
    values (vf, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', vk, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0002');
    get diagnostics n = row_count; res := n;
  exception when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into p_result (label, want, got, ok) values ('family-wide->child: the child cannot log the same 08:00 of today ''taken'' a second time', 'error:23505', res, res like 'error:23505%');
  -- control: tomorrow's 08:00 of the Vitamin D is the child's to log
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000e0002', 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000e0002', true);
  execute 'set local role authenticated';
  begin
    insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by)
    values (vf, '00000000-0000-4000-8000-0000000e0bfa', '00000000-0000-4000-8000-0000000e0cfa', vk, date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 day 8 hours', 'taken', now(), '00000000-0000-4000-8000-0000000e0002');
    get diagnostics n = row_count; res := n;
  exception when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into p_result (label, want, got, ok) values ('family-wide->child: control, the child logs tomorrow''s 08:00 of the Vitamin D', '1', res, res = '1');
end $b$;
do $v$
declare r record; bad int;
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
  end loop;
  select count(*) into bad from p_result where not ok;
  raise notice 'reviewer verdict: % of % held', (select count(*) from p_result) - bad, (select count(*) from p_result);
end $v$;
rollback;
```

### REPORTS, uncommented: reports-r4.sql

```sql
-- The read-only reports of owner actions #1 (c) and (c') (round 4) and #2 (9), uncommented, to check they run.
\echo '#1 (c):'
select d.id, d.family_id, d.medication_id, d.schedule_id,
       s.medication_id as schedule_is_for_medication, d.member_id,
       d.scheduled_for, d.status, d.logged_by, d.created_at
  from public.medication_doses d
  left join public.medication_schedules s on s.id = d.schedule_id
 where d.schedule_id is not null
   and not exists (select 1 from public.medication_schedules s2
                    where s2.id = d.schedule_id and s2.medication_id = d.medication_id
                      and s2.family_id = d.family_id)
 order by d.family_id, d.scheduled_for, d.id;
\echo '#1 (c''):'
with known as materialized (
  select name from pg_timezone_names union select abbrev from pg_timezone_abbrevs)
select d.id, d.family_id, d.medication_id, m.member_id as medicine_is_for,
       d.member_id, d.schedule_id, d.scheduled_for, d.status, d.logged_by, d.created_at,
       (d.scheduled_for at time zone z.tz)::date >= (now() at time zone z.tz)::date
         and not (d.status = 'taken' and (d.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date) as unscheduled_by_e,
       d.status = 'taken' and (d.scheduled_for at time zone z.tz)::date = (now() at time zone z.tz)::date as kept_as_taken_today
  from public.medication_doses d
  join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
  join public.families f on f.id = d.family_id
  cross join lateral (select coalesce((select k.name from known k where k.name = f.timezone limit 1), 'UTC') as tz) z
 where d.schedule_id is not null
   and exists (select 1 from public.medication_schedules s
                where s.id = d.schedule_id and s.medication_id = d.medication_id
                  and s.family_id = d.family_id)
   and m.member_id is not null and m.member_id is distinct from d.member_id
 order by d.family_id, d.scheduled_for, d.id;
\echo '#2 (9) report:'
select 'thread' as kind, n.id, n.listing_id, l.family_id as seller_family_id,
       n.buyer_family_id as other_family_id, n.status, null::bigint as amount_cents,
       exists (select 1 from public.marketplace_listing_shares s where s.listing_id = l.id) as listing_is_shared,
       n.created_at
  from public.marketplace_negotiations n
  join public.marketplace_listings l on l.id = n.listing_id
 where n.status = 'open'
   and not public.marketplace_family_sees_listing(n.listing_id, n.buyer_family_id)
union all
select 'bid', b.id, b.listing_id, l.family_id, b.bidder_family_id, b.status, b.amount_cents,
       exists (select 1 from public.marketplace_listing_shares s where s.listing_id = l.id),
       b.created_at
  from public.marketplace_bids b
  join public.marketplace_listings l on l.id = b.listing_id
 where b.status in ('active', 'outbid') and l.sale_format = 'auction' and l.status = 'available'
   and not public.marketplace_family_sees_listing(b.listing_id, b.bidder_family_id)
 order by 4, 3, 1, 9;
```

### LOOK, the row (e) keeps: look-oa1-today-row.sql

```sql
-- After owner action #1 r4 (e): the row (e) keeps (dToday, the child's dose taken today on drops since
-- given to the teen), and what a manager and the teen can do with it. Rolled back.
\set ON_ERROR_STOP on
begin;
select 'dToday now: ' || row(schedule_id is not null, medication_id = '00000000-0000-4000-8000-00000009a0b6', member_id = '00000000-0000-4000-8000-00000009a0a4', status)::text
  from public.medication_doses where id = '00000000-0000-4000-8000-00000009a0d7';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-00000009a003', 'role', 'authenticated')::text, true) is not null as as_teen;
with u as (update public.medication_doses set status = 'skipped' where id = '00000000-0000-4000-8000-00000009a0d7' returning 1)
select 'teen: update medication_doses set status=''skipped'' where id=<dToday> -> ' || count(*) from u;
with d as (delete from public.medication_doses where id = '00000000-0000-4000-8000-00000009a0d7' returning 1)
select 'teen: delete medication_doses where id=<dToday> -> ' || count(*) from d;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-00000009a001', 'role', 'authenticated')::text, true) is not null as as_parent;
with u as (update public.medication_doses set status = 'skipped' where id = '00000000-0000-4000-8000-00000009a0d7' returning 1)
select 'parent: update medication_doses set status=''skipped'' where id=<dToday> -> ' || count(*) from u;
with d as (delete from public.medication_doses where id = '00000000-0000-4000-8000-00000009a0d7' returning 1)
select 'parent: delete medication_doses where id=<dToday> -> ' || count(*) from d;
reset role;
rollback;
```

### LOOK, the row (e) moves (round 3): look-oa1-e-row.sql

```sql
-- After owner action #1 (e): what a manager can do with the unscheduled row (e) kept (dV). Rolled back.
\set ON_ERROR_STOP on
begin;
select 'dV now: ' || row(schedule_id is null, medication_id = '00000000-0000-4000-8000-00000009a0b1', member_id = '00000000-0000-4000-8000-00000009a0a4', status)::text
  from public.medication_doses where id = '00000000-0000-4000-8000-00000009a0d5';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-00000009a001', 'role', 'authenticated')::text, true) is not null as as_parent;
with u as (update public.medication_doses set status = 'taken' where id = '00000000-0000-4000-8000-00000009a0d5' returning 1)
select 'parent: update medication_doses set status=''taken'' where id=<dV> -> ' || count(*) from u;
with d as (delete from public.medication_doses where id = '00000000-0000-4000-8000-00000009a0d5' returning 1)
select 'parent: delete medication_doses where id=<dV> -> ' || count(*) from d;
reset role;
rollback;
```

## OWNER ACTION #2 (N5 + N6 + N7, OA2-unshare, OA2-no-repair)

OWNER ACTION #2 (N5 + N6 + N7, OA2-unshare, OA2-no-repair). SQL, to apply as one migration. UNCHANGED from round 3: round 2's file followed by step (9).

The steps:
- (1)-(4): new functions, each revoked from public, anon and authenticated and granted to service_role: marketplace_family_sees_listing, marketplace_recompute_auction_leader, marketplace_retract_unseen_bids and marketplace_close_circle_crossings.
- (5)-(7): the live bodies of marketplace_remove_circle_member, marketplace_leave_circle, marketplace_negotiation_respond and marketplace_close_auction, plus only the lines that call (1)-(4).
- (8): an AFTER DELETE trigger on marketplace_listing_shares.
- (9): a one-time, re-runnable sweep of crossings made before the file. Its report is in a comment. REVIEW IT FIRST: the sweep also closes SEED_ALL's 40 'Offer Makers' threads and 456 'Auction Bidders' bids on never-shared listings, which 0462's rule hides from the buyer. To keep those rows, add 'the listing has a share' to both where clauses.

For the owner to confirm:
- a closed thread gets 'expired';
- a crossing bid gets 'retracted', and its auction is re-priced;
- marketplace_offers is not touched.

No app change can do this: negotiations and bids are read-only to clients (0186). components/marketplace/auction-panel.tsx:99 and :218-222 already drop retracted bids.

PROBES, re-run this round. On copy A:
- probe-n5-n7-r2 (35): 26 FAIL before, 35 of 35 after.
- probe-oa2-cascades (5): 2 FAIL before ('the dissolve closed O's thread on the vase', '... retracted O's bid on the oar'), 5 of 5 after.
- seed-oa2-preexisting (committed before #2), then probe-oa2-preexisting (8, inline below): 6 FAIL before, 8 of 8 after.
- (9), first application: NOTICE '(9) closed 41 open thread(s) and retracted 457 standing bid(s) that crossed the boundary, on the listings of 2 seller famil(ies)'. Second application: 'closed 0 ... 0 ... 0'. The (9) report then returns 0 rows.
On B and D: 40 threads and 456 bids, then 0. On B with everything applied: probe-n5-n7-r2 35/35, cascades 5/5.

### OWNER ACTION #2, full migration (unchanged from round 3): oa2-fix-n5-n7-r4.sql

```sql
-- N5 + N6 + N7: a family that leaves a circle (removed and blocked by the
-- owner, or of its own accord) takes its open deals across the new boundary
-- with it. 0483's removal and 0176's leave deleted only shares and the
-- membership: open negotiations and standing bids between the departed family
-- and those still in the circle stayed live, and negotiation_respond (counter,
-- accept) and close_auction never asked marketplace_listing_visible_to, so a
-- removed, blocked or departed family, or the family left behind, got a
-- confirmed order on a listing the buyer could no longer see.

-- 1. Whether a FAMILY (not the caller) can see a listing: the 0462 rule
--    without its caller check, for the definer functions below to ask about
--    the other party. Server-only.
create or replace function public.marketplace_family_sees_listing(p_listing_id uuid, p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.marketplace_listings l
     where l.id = p_listing_id
       and (l.family_id = p_family_id
            or exists (select 1
                         from public.marketplace_listing_shares s
                         join public.marketplace_circle_members m on m.circle_id = s.circle_id
                        where s.listing_id = l.id
                          and m.family_id = p_family_id)));
$$;
revoke all on function public.marketplace_family_sees_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function public.marketplace_family_sees_listing(uuid, uuid) to service_role;

-- 2. Re-price a live auction from the bids still standing, as the proxy rule
--    of marketplace_place_bid_unchecked would have: the highest max leads (the
--    earlier bid on a tie) and shows one increment over the best other
--    family's max, never above its own max, at least the starting bid, and at
--    least the reserve once its max covers it. No standing bid: no leader.
create or replace function public.marketplace_recompute_auction_leader(p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_listing public.marketplace_listings%rowtype;
  v_lead    public.marketplace_bids%rowtype;
  v_count   int;
  v_second  bigint;
  v_price   bigint;
begin
  select * into v_listing from public.marketplace_listings where id = p_listing_id for update;
  if not found or v_listing.sale_format <> 'auction' or v_listing.status <> 'available' then return; end if;

  select count(*) into v_count from public.marketplace_bids
   where listing_id = p_listing_id and status in ('active', 'outbid');
  select * into v_lead from public.marketplace_bids
   where listing_id = p_listing_id and status in ('active', 'outbid')
   order by max_cents desc, created_at asc, id asc
   limit 1;
  if not found then
    update public.marketplace_listings
       set current_bid_cents = 0, bid_count = 0, highest_bidder_member_id = null,
           highest_bidder_family_id = null, highest_max_cents = 0, updated_at = now()
     where id = p_listing_id;
    return;
  end if;

  select max(max_cents) into v_second from public.marketplace_bids
   where listing_id = p_listing_id and status in ('active', 'outbid')
     and bidder_family_id <> v_lead.bidder_family_id;
  if v_second is null then
    v_price := greatest(v_listing.starting_bid_cents, 5);
  else
    v_price := v_second + case
      when v_second < 100 then 5 when v_second < 500 then 25 when v_second < 2500 then 50
      when v_second < 10000 then 100 when v_second < 25000 then 250 when v_second < 100000 then 500
      else 1000 end;
  end if;
  v_price := least(v_lead.max_cents, greatest(v_price, v_listing.starting_bid_cents));
  if v_listing.reserve_cents is not null and v_lead.max_cents >= v_listing.reserve_cents
     and v_price < v_listing.reserve_cents then
    v_price := v_listing.reserve_cents;
  end if;

  update public.marketplace_bids
     set status = case when id = v_lead.id then 'active' else 'outbid' end,
         amount_cents = case when id = v_lead.id then v_price else amount_cents end
   where listing_id = p_listing_id and status in ('active', 'outbid');
  update public.marketplace_listings
     set current_bid_cents = v_price, bid_count = v_count,
         highest_bidder_member_id = v_lead.bidder_member_id,
         highest_bidder_family_id = v_lead.bidder_family_id,
         highest_max_cents = v_lead.max_cents, updated_at = now()
   where id = p_listing_id;
end $$;
revoke all on function public.marketplace_recompute_auction_leader(uuid) from public, anon, authenticated;
grant execute on function public.marketplace_recompute_auction_leader(uuid) to service_role;

-- 3. Retract the standing bids on a live auction whose family can no longer
--    see it, and re-price what is left. Returns how many were retracted.
create or replace function public.marketplace_retract_unseen_bids(p_listing_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if not exists (select 1 from public.marketplace_listings
                  where id = p_listing_id and sale_format = 'auction' and status = 'available') then
    return 0;
  end if;
  update public.marketplace_bids b
     set status = 'retracted'
   where b.listing_id = p_listing_id and b.status in ('active', 'outbid')
     and not public.marketplace_family_sees_listing(p_listing_id, b.bidder_family_id);
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public.marketplace_recompute_auction_leader(p_listing_id); end if;
  return v_n;
end $$;
revoke all on function public.marketplace_retract_unseen_bids(uuid) from public, anon, authenticated;
grant execute on function public.marketplace_retract_unseen_bids(uuid) to service_role;

-- 4. Close what crosses the boundary once these families' shares and
--    memberships have changed: open threads whose buyer can no longer see the
--    listing end 'expired' (a status nothing else sets: neither party ended
--    it), and bids whose bidder can no longer see a live auction are retracted.
create or replace function public.marketplace_close_circle_crossings(p_families uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_listing uuid;
begin
  if p_families is null or cardinality(p_families) = 0 then return; end if;
  update public.marketplace_negotiations n
     set status = 'expired', updated_at = now()
    from public.marketplace_listings l
   where l.id = n.listing_id and n.status = 'open'
     and (n.buyer_family_id = any(p_families) or l.family_id = any(p_families))
     and not public.marketplace_family_sees_listing(n.listing_id, n.buyer_family_id);
  for v_listing in
    select distinct b.listing_id
      from public.marketplace_bids b
      join public.marketplace_listings l on l.id = b.listing_id
     where b.status in ('active', 'outbid') and l.sale_format = 'auction' and l.status = 'available'
       and (b.bidder_family_id = any(p_families) or l.family_id = any(p_families))
  loop
    perform public.marketplace_retract_unseen_bids(v_listing);
  end loop;
end $$;
revoke all on function public.marketplace_close_circle_crossings(uuid[]) from public, anon, authenticated;
grant execute on function public.marketplace_close_circle_crossings(uuid[]) to service_role;

-- 5. Removal (0483) and leaving (0176) close the crossings in the same transaction.
create or replace function public.marketplace_remove_circle_member(
  p_family uuid, p_circle uuid, p_member_family uuid, p_block boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;
  if not public.marketplace_circle_owner_manager(p_circle, p_family) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_member_family is null or p_member_family = p_family then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  delete from public.marketplace_listing_shares
   where circle_id = p_circle and family_id = p_member_family;
  delete from public.marketplace_circle_members
   where circle_id = p_circle and family_id = p_member_family and role <> 'owner';
  get diagnostics v_removed = row_count;

  if coalesce(p_block, true) then
    insert into public.marketplace_circle_blocks (circle_id, family_id, blocked_by)
    values (p_circle, p_member_family, auth.uid())
    on conflict (circle_id, family_id) do nothing;
  end if;

  -- What the removed family and the families still in the circle had open
  -- across the new boundary ends with the removal.
  perform public.marketplace_close_circle_crossings(array[p_member_family]);

  return jsonb_build_object('ok', true, 'removed', v_removed > 0, 'blocked', coalesce(p_block, true));
end $$;

create or replace function public.marketplace_leave_circle(p_family uuid, p_circle uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_families uuid[];
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;

  select role into v_role from public.marketplace_circle_members
  where circle_id = p_circle and family_id = p_family;
  if v_role is null then return; end if;

  if v_role = 'owner' then
    -- The founding family leaving dissolves the circle (memberships + shares
    -- cascade), so every family in it crosses the boundary.
    select array_agg(family_id) into v_families from public.marketplace_circle_members where circle_id = p_circle;
    delete from public.marketplace_circles where id = p_circle;
  else
    v_families := array[p_family];
    delete from public.marketplace_circle_members where circle_id = p_circle and family_id = p_family;
    delete from public.marketplace_listing_shares where circle_id = p_circle and family_id = p_family;
  end if;
  perform public.marketplace_close_circle_crossings(v_families);
end $function$;

-- 6. Counter and accept answer to the buyer family's sight of the listing, as
--    negotiation_offer and place_bid already do (0462); a thread that crossed
--    the boundary before step 5 existed is closed the first time it is acted on.
CREATE OR REPLACE FUNCTION public.marketplace_negotiation_respond(p_negotiation uuid, p_action text, p_amount bigint DEFAULT NULL::bigint, p_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_neg     public.marketplace_negotiations%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_seller_member uuid;
  v_buyer_caller  uuid;
  v_role    text;
  v_actor   uuid;
  v_order   uuid;
begin
  select * into v_neg from public.marketplace_negotiations where id = p_negotiation for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into v_listing from public.marketplace_listings where id = v_neg.listing_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'listing_missing'); end if;
  if v_neg.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'not_open'); end if;

  -- Who is calling? Seller (listing owner) or the buyer on this thread.
  v_seller_member := public.marketplace_member_id(v_listing.family_id);
  v_buyer_caller  := public.marketplace_member_id(v_neg.buyer_family_id);
  if v_seller_member is not null and v_seller_member = v_listing.member_id then
    v_role := 'seller'; v_actor := v_seller_member;
  elsif v_buyer_caller is not null and v_buyer_caller = v_neg.buyer_member_id then
    v_role := 'buyer'; v_actor := v_buyer_caller;
  else
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  if p_action = 'withdraw' then
    if v_role <> 'buyer' then return jsonb_build_object('ok', false, 'reason', 'buyer_only'); end if;
    update public.marketplace_negotiations set status = 'withdrawn', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'withdraw', p_message);
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if p_action = 'decline' then
    if v_role <> 'seller' then return jsonb_build_object('ok', false, 'reason', 'seller_only'); end if;
    update public.marketplace_negotiations set status = 'declined', updated_at = now() where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'decline', p_message);
    return jsonb_build_object('ok', true, 'status', 'declined');
  end if;

  -- Countering or accepting moves the deal toward a confirmed order with
  -- another family, so a parent or adult of the acting side does it
  -- (0483). Withdrawing and declining only end a thread, and stay
  -- open to the party themselves.
  if p_action in ('counter', 'accept')
     and not public.can_manage_family(case v_role when 'seller' then v_listing.family_id
                                                  else v_neg.buyer_family_id end) then
    return jsonb_build_object('ok', false, 'reason', 'manager_only');
  end if;

  -- And only while the buyer family can still see the listing (0462): a
  -- family removed from, or gone from, the circle it was shared into does
  -- not counter or close a deal on it, and nor does its seller with them.
  if p_action in ('counter', 'accept')
     and not public.marketplace_family_sees_listing(v_listing.id, v_neg.buyer_family_id) then
    update public.marketplace_negotiations set status = 'expired', updated_at = now() where id = v_neg.id;
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- counter / accept require it to be this caller's turn.
  if (v_role = 'seller' and v_neg.last_actor <> 'buyer')
     or (v_role = 'buyer' and v_neg.last_actor <> 'seller') then
    return jsonb_build_object('ok', false, 'reason', 'not_your_turn');
  end if;

  if p_action = 'counter' then
    if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
    update public.marketplace_negotiations
       set current_amount_cents = p_amount, last_actor = v_role,
           rounds_count = rounds_count + 1, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'counter', p_amount, p_message);
    return jsonb_build_object('ok', true, 'status', 'open', 'amount_cents', p_amount);
  end if;

  if p_action = 'accept' then
    if v_listing.status not in ('available','pending') then
      return jsonb_build_object('ok', false, 'reason', 'not_available');
    end if;
    -- Claim the listing for this buyer + record the deal at the agreed price.
    update public.marketplace_listings
       set status = 'claimed', claimed_by = v_neg.buyer_member_id, claimed_at = now(), updated_at = now()
     where id = v_listing.id;

    insert into public.marketplace_orders
      (family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_by)
    values (v_listing.family_id, v_neg.buyer_family_id, v_listing.id, v_neg.buyer_member_id, v_listing.member_id,
            'buy', 'confirmed', v_neg.current_amount_cents, 'Agreed via Make an Offer', auth.uid())
    returning id into v_order;

    update public.marketplace_negotiations
       set status = 'agreed', agreed_amount_cents = v_neg.current_amount_cents,
           order_id = v_order, updated_at = now()
     where id = v_neg.id;
    insert into public.marketplace_negotiation_rounds
      (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message)
    values (v_neg.id, v_listing.id, v_actor, v_role, 'accept', v_neg.current_amount_cents, p_message);

    -- Close every competing thread + open offer on this now-claimed listing.
    update public.marketplace_negotiations set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open' and id <> v_neg.id;
    update public.marketplace_offers set status = 'declined', updated_at = now()
     where listing_id = v_listing.id and status = 'open';

    return jsonb_build_object('ok', true, 'status', 'agreed', 'order_id', v_order,
                              'amount_cents', v_neg.current_amount_cents);
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_action');
end $function$;

-- 7. The close sells only to a bidder who can still see the auction: unseen
--    bids are retracted and the auction re-priced first, so a bid that crossed
--    the boundary before step 5 existed falls to the best bidder still in.
CREATE OR REPLACE FUNCTION public.marketplace_close_auction(p_listing_id uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_listing record;
  v_now timestamptz := coalesce(p_now, now());
  v_sold boolean;
  v_amount bigint;
  v_order_id uuid;
begin
  -- Inside a SECURITY DEFINER function current_user is the OWNER, never the
  -- caller; the caller's role is in the request's JWT claims (0457).
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_listing
  from public.marketplace_listings
  where id = p_listing_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_listing.sale_format <> 'auction'
    or v_listing.status <> 'available'
    or v_listing.auction_ends_at is null
    or v_listing.auction_ends_at > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_due');
  end if;

  if public.marketplace_retract_unseen_bids(p_listing_id) > 0 then
    select * into v_listing from public.marketplace_listings where id = p_listing_id for update;
  end if;

  v_sold := v_listing.bid_count > 0
    and v_listing.highest_max_cents >= coalesce(v_listing.reserve_cents, 0)
    and v_listing.highest_bidder_member_id is not null
    and v_listing.highest_bidder_family_id is not null;
  v_amount := greatest(v_listing.current_bid_cents, coalesce(v_listing.reserve_cents, 0));

  update public.marketplace_listings
  set status = case when v_sold then 'claimed' else 'withdrawn' end,
      current_bid_cents = case when v_sold then v_amount else current_bid_cents end,
      auction_closed_at = v_now,
      claimed_by = case when v_sold then v_listing.highest_bidder_member_id else null end,
      claimed_at = case when v_sold then v_now else null end,
      updated_at = v_now
  where id = v_listing.id and status = 'available';

  if v_sold then
    insert into public.marketplace_orders
      (family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status,
       amount_cents, notes)
    values
      (v_listing.family_id, v_listing.highest_bidder_family_id, v_listing.id,
       v_listing.highest_bidder_member_id, v_listing.member_id, 'buy', 'confirmed', v_amount,
       'Won at auction')
    returning id into v_order_id;

    update public.marketplace_bids
    set status = 'won'
    where listing_id = v_listing.id
      and bidder_member_id = v_listing.highest_bidder_member_id
      and status = 'active';

    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  else
    update public.marketplace_bids
    set status = 'lost'
    where listing_id = v_listing.id and status in ('active', 'outbid');
  end if;

  return jsonb_build_object(
    'ok', true,
    'reason', 'closed',
    'sold', v_sold,
    'had_bids', v_listing.bid_count > 0,
    'listing_id', v_listing.id,
    'title', v_listing.title,
    'seller_family_id', v_listing.family_id,
    'winner_family_id', case when v_sold then v_listing.highest_bidder_family_id else null end,
    'winner_member_id', case when v_sold then v_listing.highest_bidder_member_id else null end,
    'current_bid_cents', case when v_sold then v_amount else v_listing.current_bid_cents end,
    'order_id', v_order_id
  );
end $function$;

-- 8. Unsharing closes the crossings too, as removal and leaving do (5).
--    unshareListingAction deletes the marketplace_listing_shares row under
--    mkt_listing_shares_delete. That takes the listing out of every other
--    family's sight in that circle, but before this:
--    - their open threads stayed 'open' in the seller's inbox;
--    - their standing bids kept setting the price other bidders face, and kept
--      counting toward bid_count, which closes Buy-It-Now;
--    - this lasted until someone acted or the auction closed (6 and 7 only
--      catch them then), and the family that can no longer see the listing
--      cannot withdraw from the screen.
--    The trigger fires for each share however it goes: the action, a direct
--    PostgREST delete, removal and leaving (5), and a dissolved circle's
--    cascade. It is a row trigger, so plpgsql_check can resolve its body
--    (docs/audit/plpgsql-bodies-resolve-check.sql; a transition table cannot be
--    resolved). A listing that is itself being deleted is skipped, because its
--    threads and bids cascade with it. A family that still sees the listing
--    through another circle keeps its threads and bids
--    (marketplace_family_sees_listing).
create or replace function public.marketplace_listing_shares_close_crossings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seller uuid;
begin
  select l.family_id into v_seller from public.marketplace_listings l where l.id = old.listing_id;
  if v_seller is not null then
    perform public.marketplace_close_circle_crossings(array[v_seller]);
  end if;
  return old;
end $$;
revoke all on function public.marketplace_listing_shares_close_crossings() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.marketplace_listing_shares') is null then return; end if;
  execute 'drop trigger if exists trg_marketplace_listing_shares_close_crossings on public.marketplace_listing_shares';
  execute 'create trigger trg_marketplace_listing_shares_close_crossings after delete on public.marketplace_listing_shares '
       || 'for each row execute function public.marketplace_listing_shares_close_crossings()';
end $$;

-- 9. One-time sweep for the crossings made before this file (OA2-no-repair).
--    (5) and (8) close a crossing only when a removal, a leave or an unshare
--    happens after this file is applied, and (6) and (7) only once someone
--    acts on the thread or the auction closes. A family removed, departed or
--    unshared under 0483/0176 before then keeps, until then:
--    - its open threads, 'open' in the seller's inbox;
--    - its standing bids: its hidden max still sets the price the bidders
--      still in pay, and its bid still counts toward bid_count, which closes
--      Buy-It-Now.
--    The sweep closes them as (4) does, by the same 0462 rule
--    (marketplace_family_sees_listing). It also closes a crossing made under
--    an older visibility rule on a listing that was never shared, which the
--    0462 rule hides from the buyer too: on rls_tpl's SEED_ALL that is 40
--    'Offer Makers' threads and 456 'Auction Bidders' bids. Review the report
--    first; to keep such rows, add the same restriction to the report's and
--    the sweep's where clauses (for example: the listing has a share).
--
--    Report (read-only), before the sweep:
--      select 'thread' as kind, n.id, n.listing_id, l.family_id as seller_family_id,
--             n.buyer_family_id as other_family_id, n.status, null::bigint as amount_cents,
--             exists (select 1 from public.marketplace_listing_shares s where s.listing_id = l.id) as listing_is_shared,
--             n.created_at
--        from public.marketplace_negotiations n
--        join public.marketplace_listings l on l.id = n.listing_id
--       where n.status = 'open'
--         and not public.marketplace_family_sees_listing(n.listing_id, n.buyer_family_id)
--      union all
--      select 'bid', b.id, b.listing_id, l.family_id, b.bidder_family_id, b.status, b.amount_cents,
--             exists (select 1 from public.marketplace_listing_shares s where s.listing_id = l.id),
--             b.created_at
--        from public.marketplace_bids b
--        join public.marketplace_listings l on l.id = b.listing_id
--       where b.status in ('active', 'outbid') and l.sale_format = 'auction' and l.status = 'available'
--         and not public.marketplace_family_sees_listing(b.listing_id, b.bidder_family_id)
--       order by 4, 3, 1, 9;
--
--    The sweep is re-runnable: a second run finds nothing to close.
do $$
declare
  v_sellers uuid[];
  v_threads int;
  v_bids int;
begin
  if to_regprocedure('public.marketplace_close_circle_crossings(uuid[])') is null then
    raise exception 'marketplace_close_circle_crossings(uuid[]) (step 4) is missing';
  end if;
  select count(*) into v_threads
    from public.marketplace_negotiations n
   where n.status = 'open'
     and not public.marketplace_family_sees_listing(n.listing_id, n.buyer_family_id);
  select count(*) into v_bids
    from public.marketplace_bids b
    join public.marketplace_listings l on l.id = b.listing_id
   where b.status in ('active', 'outbid') and l.sale_format = 'auction' and l.status = 'available'
     and not public.marketplace_family_sees_listing(b.listing_id, b.bidder_family_id);
  select coalesce(array_agg(distinct l.family_id), '{}') into v_sellers
    from public.marketplace_listings l
   where exists (select 1 from public.marketplace_negotiations n
                  where n.listing_id = l.id and n.status = 'open'
                    and not public.marketplace_family_sees_listing(l.id, n.buyer_family_id))
      or (l.sale_format = 'auction' and l.status = 'available'
          and exists (select 1 from public.marketplace_bids b
                       where b.listing_id = l.id and b.status in ('active', 'outbid')
                         and not public.marketplace_family_sees_listing(l.id, b.bidder_family_id)));
  perform public.marketplace_close_circle_crossings(v_sellers);
  raise notice '(9) closed % open thread(s) and retracted % standing bid(s) that crossed the boundary, on the listings of % seller famil(ies)',
    v_threads, v_bids, cardinality(v_sellers);
end $$;
```

### PROBE SEED, committed before #2: seed-oa2-preexisting.sql

```sql
-- Reviewer seed (COMMITTED, before owner action #2): crossings made the way today's schema allows, before #2 exists.
-- S (seller) and O share circle 'Birch'. S's Lantern (fixed price) has O's open thread; S's Raft (auction) has O's leading bid
-- and P's lower bid (P is in a second circle 'Pine' with S, where the Raft is also shared).
-- S then unshares both from Birch through S's own session (mkt_listing_shares_delete), as unshareListingAction does.
\set ON_ERROR_STOP on
begin;
create function pg_temp.call(who uuid, q text) returns text language plpgsql as $f$
declare res jsonb; n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  if q ilike 'select%' then execute q into res; else execute q; get diagnostics n = row_count; res := to_jsonb(n); end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res::text;
end $f$;
do $s$
declare
  f_s uuid := '00000000-0000-4000-8000-0000000ea001'; u_s uuid := '00000000-0000-4000-8000-0000000ea011';
  f_o uuid := '00000000-0000-4000-8000-0000000ea002'; u_o uuid := '00000000-0000-4000-8000-0000000ea012';
  f_p uuid := '00000000-0000-4000-8000-0000000ea003'; u_p uuid := '00000000-0000-4000-8000-0000000ea013';
  c1 uuid := '00000000-0000-4000-8000-0000000ea0c1'; c2 uuid := '00000000-0000-4000-8000-0000000ea0c2';
  lantern uuid := '00000000-0000-4000-8000-0000000ea0a1'; raft uuid := '00000000-0000-4000-8000-0000000ea0a2';
  m_s uuid; m_o uuid; m_p uuid; r text;
begin
  insert into auth.users (id, email) values (u_s, 'oa2pre-s@example.test'), (u_o, 'oa2pre-o@example.test'), (u_p, 'oa2pre-p@example.test');
  insert into public.families (id, name, created_by) values (f_s, 'Pre Seller', u_s), (f_o, 'Pre Other', u_o), (f_p, 'Pre Pine', u_p);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (f_s, u_s, 'S', 'parent', true), (f_o, u_o, 'O', 'parent', true), (f_p, u_p, 'P', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_s from public.family_members where family_id = f_s; select id into m_o from public.family_members where family_id = f_o; select id into m_p from public.family_members where family_id = f_p;
  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by) values (c1, 'Birch', 'RVPREAAA', f_s, u_s), (c2, 'Pine', 'RVPREBBB', f_s, u_s);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (c1, f_s, 'Pre Seller', 'owner'), (c1, f_o, 'Pre Other', 'member'), (c2, f_s, 'Pre Seller', 'owner'), (c2, f_p, 'Pre Pine', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents) values (lantern, f_s, m_s, u_s, 'Lantern', 'sell', 'available', 4000);
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, sale_format, starting_bid_cents, reserve_cents, buy_now_cents, auction_ends_at) values
    (raft, f_s, m_s, u_s, 'Raft', 'sell', 'available', 'auction', 1000, null, null, now() + interval '2 days');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values (lantern, c1, f_s), (raft, c1, f_s), (raft, c2, f_s);
  r := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 3000)', lantern, m_o, f_o)); raise notice 'O offers on the Lantern: %', r;
  r := pg_temp.call(u_p, format('select public.marketplace_place_bid(%L, %L, %L, 1500)', raft, m_p, f_p)); raise notice 'P bids 1500 max on the Raft: %', r;
  r := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 5000)', raft, m_o, f_o)); raise notice 'O bids 5000 max on the Raft: %', r;
  r := pg_temp.call(u_s, format('delete from public.marketplace_listing_shares where listing_id = %L and circle_id = %L and family_id = %L', lantern, c1, f_s)); raise notice 'S unshares the Lantern from Birch: %', r;
  r := pg_temp.call(u_s, format('delete from public.marketplace_listing_shares where listing_id = %L and circle_id = %L and family_id = %L', raft, c1, f_s)); raise notice 'S unshares the Raft from Birch: %', r;
end $s$;
commit;
```

### PROBE: probe-oa2-preexisting.sql

```sql
-- PROBE OA2-no-repair: crossings made BEFORE owner action #2 (seed-oa2-preexisting.sql,
-- committed first: O's open thread on S's Lantern and O's leading bid on S's Raft, then S
-- unshares both from the Birch circle; P still sees the Raft through Pine). Asserts what
-- owner action #2 with its sweep (9) leaves: the thread is closed, O's bid is retracted and
-- the auction re-priced without it, P's bid stands, and the report finds nothing. Rolled back.
\set ON_ERROR_STOP on
begin;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got, got is not distinct from want);
end $f$;
do $probe$
declare
  f_s uuid := '00000000-0000-4000-8000-0000000ea001';
  f_o uuid := '00000000-0000-4000-8000-0000000ea002';
  f_p uuid := '00000000-0000-4000-8000-0000000ea003';
  lantern uuid := '00000000-0000-4000-8000-0000000ea0a1';
  raft uuid := '00000000-0000-4000-8000-0000000ea0a2';
  fams uuid[] := array['00000000-0000-4000-8000-0000000ea001', '00000000-0000-4000-8000-0000000ea002', '00000000-0000-4000-8000-0000000ea003']::uuid[];
begin
  if not exists (select 1 from public.marketplace_listings where id = raft) then
    raise exception 'probe fixture: seed-oa2-preexisting.sql has not been run';
  end if;
  -- The 0462 rule, inlined, so the probe reads the same before owner action #2 exists.
  perform pg_temp.p_expect('control: O no longer sees the Lantern or the Raft (both unshared from Birch)',
    (select count(*)::text from public.marketplace_listings l
      where l.id in (lantern, raft)
        and (l.family_id = f_o or exists (select 1 from public.marketplace_listing_shares s
              join public.marketplace_circle_members m on m.circle_id = s.circle_id
             where s.listing_id = l.id and m.family_id = f_o))), '0');
  perform pg_temp.p_expect('control: P still sees the Raft (Pine)',
    (select count(*)::text from public.marketplace_listing_shares s
      join public.marketplace_circle_members m on m.circle_id = s.circle_id
     where s.listing_id = raft and m.family_id = f_p), '1');
  perform pg_temp.p_expect('the report finds no open thread across the boundary among these families',
    (select count(*)::text from public.marketplace_negotiations n
       join public.marketplace_listings l on l.id = n.listing_id
      where n.status = 'open' and l.family_id = any(fams)
        and not (l.family_id = n.buyer_family_id or exists (select 1 from public.marketplace_listing_shares s
              join public.marketplace_circle_members m on m.circle_id = s.circle_id
             where s.listing_id = l.id and m.family_id = n.buyer_family_id))), '0');
  perform pg_temp.p_expect('the report finds no standing bid across the boundary among these families',
    (select count(*)::text from public.marketplace_bids b
       join public.marketplace_listings l on l.id = b.listing_id
      where b.status in ('active', 'outbid') and l.family_id = any(fams) and l.sale_format = 'auction' and l.status = 'available'
        and not (l.family_id = b.bidder_family_id or exists (select 1 from public.marketplace_listing_shares s
              join public.marketplace_circle_members m on m.circle_id = s.circle_id
             where s.listing_id = l.id and m.family_id = b.bidder_family_id))), '0');
  perform pg_temp.p_expect('O''s open thread on the Lantern is closed',
    (select string_agg(status, ',') from public.marketplace_negotiations where listing_id = lantern and buyer_family_id = f_o), 'expired');
  perform pg_temp.p_expect('O''s bid on the Raft is retracted',
    (select string_agg(status, ',') from public.marketplace_bids where listing_id = raft and bidder_family_id = f_o), 'retracted');
  perform pg_temp.p_expect('P''s bid stands and leads at the starting bid (O''s hidden max no longer sets P''s price)',
    (select string_agg(status || '@' || amount_cents, ',') from public.marketplace_bids where listing_id = raft and bidder_family_id = f_p), 'active@1000');
  perform pg_temp.p_expect('the Raft is re-priced: current 1000, bid_count 1 (Buy-It-Now counts only P), P leads',
    (select format('current=%s bid_count=%s leader=%s', current_bid_cents, bid_count,
       case highest_bidder_family_id when f_p then 'P' when f_o then 'O' else coalesce(highest_bidder_family_id::text, 'none') end)
       from public.marketplace_listings where id = raft), 'current=1000 bid_count=1 leader=P');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe OA2 preexisting: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe OA2 preexisting: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (round 2, unchanged): probe-n5-n7-r2.sql

```sql
-- PROBE N5/N6/N7 (+ OA2-unshare): a family that leaves a circle (removed and
-- blocked, or of its own accord), or whose sight of a listing ends because the
-- seller unshared it, takes its open deals across the new boundary with it:
-- nobody gets a confirmed order on a listing the buyer can no longer see, and
-- the unshare itself closes the thread and retracts the bid. Rolled back.
\set ON_ERROR_STOP on
begin;

-- Run `q` (a select returning one jsonb) as `who` with `role`; the jsonb as text, or the error.
create function pg_temp.call(who uuid, q text, r text default 'authenticated') returns text language plpgsql as $f$
declare res jsonb; out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claim.role', r, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', r)::text, true);
  execute format('set local role %I', r);
  begin
    execute q into res;
    out := coalesce(res::text, 'null');
  exception when others then out := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  return out;
end $f$;

create function pg_temp.j(res text) returns jsonb language sql immutable as
  $$ select case when res like 'error:%' then jsonb_build_object('error', res) else res::jsonb end $$;

create temp table p_result (seq serial, label text, ok boolean, got text) on commit drop;
create function pg_temp.check(label text, ok boolean, got text) returns void language sql as
  $$ insert into p_result (label, ok, got) values (label, coalesce(ok, false), got) $$;

do $probe$
declare
  f_s uuid := '00000000-0000-4000-8000-00000007a001';  -- circle owner, seller
  f_b uuid := '00000000-0000-4000-8000-00000007a002';  -- member, then removed and blocked
  f_o uuid := '00000000-0000-4000-8000-00000007a003';  -- member who stays
  f_l uuid := '00000000-0000-4000-8000-00000007a004';  -- member who leaves of its own accord
  u_s uuid := '00000000-0000-4000-8000-00000007a011';
  u_b uuid := '00000000-0000-4000-8000-00000007a012';
  u_o uuid := '00000000-0000-4000-8000-00000007a013';
  u_l uuid := '00000000-0000-4000-8000-00000007a014';
  m_s uuid; m_b uuid; m_o uuid; m_l uuid;
  circle uuid := '00000000-0000-4000-8000-00000007a0c1';
  crib uuid := gen_random_uuid(); desk uuid := gen_random_uuid(); chair uuid := gen_random_uuid();
  bike uuid := gen_random_uuid(); grill uuid := gen_random_uuid(); sofa uuid := gen_random_uuid(); lamp uuid := gen_random_uuid();
  shelf uuid := gen_random_uuid(); kayak uuid := gen_random_uuid(); t_shelf uuid;
  t_crib uuid; t_desk uuid; t_desk_o uuid; t_sofa uuid; t_lamp uuid; t_chair uuid;
  -- OA2-unshare: T is in a second circle with S only; the Table and the Canoe are shared into both.
  f_t uuid := '00000000-0000-4000-8000-00000007a005';
  u_t uuid := '00000000-0000-4000-8000-00000007a015';
  m_t uuid;
  circle2 uuid := '00000000-0000-4000-8000-00000007a0c2';
  tbl uuid := gen_random_uuid(); canoe uuid := gen_random_uuid(); t_tbl_o uuid; t_tbl_t uuid;
  res text; n int;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (u_s, 'n5-s@example.test'), (u_b, 'n5-b@example.test'), (u_o, 'n5-o@example.test'), (u_l, 'n5-l@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (f_s, 'Seller House', u_s), (f_b, 'Buyer House', u_b), (f_o, 'Other House', u_o), (f_l, 'Leaving House', u_l) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (f_s, u_s, 'SParent', 'parent', true), (f_b, u_b, 'BParent', 'parent', true), (f_o, u_o, 'OParent', 'parent', true), (f_l, u_l, 'LParent', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_s from public.family_members where family_id = f_s and user_id = u_s;
  select id into m_b from public.family_members where family_id = f_b and user_id = u_b;
  select id into m_o from public.family_members where family_id = f_o and user_id = u_o;
  select id into m_l from public.family_members where family_id = f_l and user_id = u_l;
  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by) values (circle, 'Elm Street', 'N5PROBE1', f_s, u_s);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (circle, f_s, 'Seller House', 'owner'), (circle, f_b, 'Buyer House', 'member'), (circle, f_o, 'Other House', 'member'), (circle, f_l, 'Leaving House', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents) values
    (crib, f_s, m_s, u_s, 'Crib', 'sell', 'available', 10000),
    (desk, f_s, m_s, u_s, 'Desk', 'sell', 'available', 5000),
    (chair, f_s, m_s, u_s, 'Chair', 'sell', 'available', 4000),
    (sofa, f_b, m_b, u_b, 'Sofa', 'sell', 'available', 20000),
    (lamp, f_l, m_l, u_l, 'Lamp', 'sell', 'available', 3000),
    (shelf, f_s, m_s, u_s, 'Shelf', 'sell', 'available', 6000);
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, sale_format, starting_bid_cents, reserve_cents, buy_now_cents, auction_ends_at) values
    (bike, f_s, m_s, u_s, 'Bike', 'sell', 'available', 'auction', 1000, null, null, now() + interval '1 day'),
    (grill, f_b, m_b, u_b, 'Grill', 'sell', 'available', 'auction', 1000, null, null, now() + interval '1 day'),
    (kayak, f_s, m_s, u_s, 'Kayak', 'sell', 'available', 'auction', 1000, null, null, now() + interval '1 day');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values
    (crib, circle, f_s), (desk, circle, f_s), (chair, circle, f_s), (bike, circle, f_s), (sofa, circle, f_b), (grill, circle, f_b), (lamp, circle, f_l), (shelf, circle, f_s), (kayak, circle, f_s);
  -- OA2-unshare fixture: T's house, a second circle 'Oak Lane' (S and T), the Table and the Canoe in both circles.
  insert into auth.users (id, email) values (u_t, 'n5-t@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (f_t, 'Twin House', u_t) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (f_t, u_t, 'TParent', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_t from public.family_members where family_id = f_t and user_id = u_t;
  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by) values (circle2, 'Oak Lane', 'N5PROBE2', f_s, u_s);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (circle2, f_s, 'Seller House', 'owner'), (circle2, f_t, 'Twin House', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents) values
    (tbl, f_s, m_s, u_s, 'Table', 'sell', 'available', 9000);
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, sale_format, starting_bid_cents, reserve_cents, buy_now_cents, auction_ends_at) values
    (canoe, f_s, m_s, u_s, 'Canoe', 'sell', 'available', 'auction', 1000, null, null, now() + interval '1 day');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values
    (tbl, circle, f_s), (tbl, circle2, f_s), (canoe, circle, f_s), (canoe, circle2, f_s);

  -- The deals in flight, made as each real actor would.
  res := pg_temp.call(u_b, format('select public.marketplace_negotiation_offer(%L, %L, %L, 6000)', crib, m_b, f_b));
  t_crib := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''counter'', 8000)', t_crib));
  res := pg_temp.call(u_b, format('select public.marketplace_negotiation_offer(%L, %L, %L, 3000)', desk, m_b, f_b));
  t_desk := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''counter'', 4000)', t_desk));
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 3500)', desk, m_o, f_o));
  t_desk_o := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 15000)', sofa, m_o, f_o));
  t_sofa := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 2000)', lamp, m_o, f_o));
  t_lamp := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_l, format('select public.marketplace_negotiation_offer(%L, %L, %L, 3000)', chair, m_l, f_l));
  t_chair := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_b, format('select public.marketplace_place_bid(%L, %L, %L, 2500)', bike, m_b, f_b));
  res := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 2000)', bike, m_o, f_o));
  res := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 3000)', grill, m_o, f_o));
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 4000)', shelf, m_o, f_o));
  t_shelf := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''counter'', 5000)', t_shelf));
  res := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 2200)', kayak, m_o, f_o));
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 7000)', tbl, m_o, f_o));
  t_tbl_o := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_t, format('select public.marketplace_negotiation_offer(%L, %L, %L, 6500)', tbl, m_t, f_t));
  t_tbl_t := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_t, format('select public.marketplace_place_bid(%L, %L, %L, 2500)', canoe, m_t, f_t));
  res := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 3000)', canoe, m_o, f_o));
  if t_tbl_o is null or t_tbl_t is null then raise exception 'probe fixture: a Table thread was not opened (%)', res; end if;
  if not exists (select 1 from public.marketplace_listings where id = canoe and highest_bidder_family_id = f_o and bid_count = 2) then
    raise exception 'probe fixture: O does not lead the Canoe with two bids';
  end if;
  if t_shelf is null or t_desk is null or t_desk_o is null or t_sofa is null or t_lamp is null or t_chair is null then
    raise exception 'probe fixture: a negotiation was not opened (%)', res;
  end if;
  select count(*) into n from public.marketplace_bids where listing_id in (bike, grill);
  if n <> 3 then raise exception 'probe fixture: % bids placed, expected 3', n; end if;
  if not exists (select 1 from public.marketplace_bids where listing_id = kayak and bidder_family_id = f_o) then raise exception 'probe fixture: no bid on the kayak'; end if;

  -- S's parent removes and blocks B; L leaves of its own accord.
  res := pg_temp.call(u_s, format('select public.marketplace_remove_circle_member(%L, %L, %L, true)', f_s, circle, f_b));
  perform pg_temp.check('setup: the owner removes and blocks B', (pg_temp.j(res)->>'ok')::boolean, res);
  res := pg_temp.call(u_l, format('select jsonb_build_object(''left'', public.marketplace_leave_circle(%L, %L)::text)', f_l, circle));
  perform pg_temp.check('setup: L leaves the circle', res not like 'error:%', res);

  -- N5: the removed buyer's open threads on the owner's listings
  perform pg_temp.check('N5: the removal closed B''s open threads on S''s listings',
    not exists (select 1 from public.marketplace_negotiations where id in (t_crib, t_desk) and status = 'open'),
    (select string_agg(status, ',') from public.marketplace_negotiations where id in (t_crib, t_desk)));
  res := pg_temp.call(u_b, format('select public.marketplace_negotiation_respond(%L, ''counter'', 4500)', t_desk));
  perform pg_temp.check('N5: removed B counters S''s standing counter', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  res := pg_temp.call(u_b, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_crib));
  perform pg_temp.check('N5: removed B accepts S''s counter on the crib', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  perform pg_temp.check('N5: no order for B on S''s crib, and the crib is still available',
    not exists (select 1 from public.marketplace_orders where listing_id = crib)
      and exists (select 1 from public.marketplace_listings where id = crib and status = 'available'),
    (select status from public.marketplace_listings where id = crib));

  -- N7: the remaining family's offer on the removed family's listing
  perform pg_temp.check('N7: the removal closed O''s open thread on B''s sofa',
    not exists (select 1 from public.marketplace_negotiations where id = t_sofa and status = 'open'),
    (select status from public.marketplace_negotiations where id = t_sofa));
  res := pg_temp.call(u_b, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_sofa));
  perform pg_temp.check('N7: removed seller B accepts O''s offer on the sofa', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  perform pg_temp.check('N7: no order for O on B''s sofa', not exists (select 1 from public.marketplace_orders where listing_id = sofa), null);
  -- N7 (leave): the departed seller and the departed buyer
  res := pg_temp.call(u_l, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_lamp));
  perform pg_temp.check('N7 leave: departed seller L accepts O''s offer on the lamp', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_chair));
  perform pg_temp.check('N7 leave: S accepts departed L''s offer on the chair', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  perform pg_temp.check('N7 leave: no order on the lamp or the chair', not exists (select 1 from public.marketplace_orders where listing_id in (lamp, chair)), null);

  -- N6: the removed family's leading bid on the owner's auction
  perform pg_temp.check('N6: the removal retracted B''s bid on S''s bike',
    not exists (select 1 from public.marketplace_bids where listing_id = bike and bidder_family_id = f_b and status in ('active', 'outbid')),
    (select string_agg(status, ',') from public.marketplace_bids where listing_id = bike and bidder_family_id = f_b));
  res := pg_temp.call(null, format('select public.marketplace_close_auction(%L, now() + interval ''2 days'')', bike), 'service_role');
  perform pg_temp.check('N6: the close does not sell S''s bike to removed B', coalesce(pg_temp.j(res)->>'winner_family_id', '') <> f_b::text, res);
  perform pg_temp.check('N6: no order for B on the bike', not exists (select 1 from public.marketplace_orders where listing_id = bike and buyer_family_id = f_b), null);
  -- N7: the remaining family's leading bid on the removed family's auction
  res := pg_temp.call(null, format('select public.marketplace_close_auction(%L, now() + interval ''2 days'')', grill), 'service_role');
  perform pg_temp.check('N7: the close does not sell B''s grill to O, who can no longer see it', coalesce(pg_temp.j(res)->>'winner_family_id', '') <> f_o::text, res);
  perform pg_temp.check('N7: no order for O on the grill', not exists (select 1 from public.marketplace_orders where listing_id = grill), null);

  -- A thread or a bid that crossed without a removal step to close it (the
  -- seller unshared the listing; or one left over from before the fix): the
  -- respond and the close answer to the buyer's sight of the listing themselves.
  res := pg_temp.call(u_s, format('with d as (delete from public.marketplace_listing_shares where listing_id in (%L, %L) returning 1) select jsonb_build_object(''unshared'', count(*)) from d', shelf, kayak));
  perform pg_temp.check('setup: S unshares the shelf and the kayak', (pg_temp.j(res)->>'unshared')::int = 2, res);
  -- OA2-unshare: the unshare itself closes them, before anyone acts.
  perform pg_temp.check('OA2-unshare: the unshare itself closed O''s thread on the shelf (expired)',
    exists (select 1 from public.marketplace_negotiations where id = t_shelf and status = 'expired'),
    (select status from public.marketplace_negotiations where id = t_shelf));
  perform pg_temp.check('OA2-unshare: the unshare itself retracted O''s bid on the kayak',
    exists (select 1 from public.marketplace_bids where listing_id = kayak and bidder_family_id = f_o and status = 'retracted'),
    (select string_agg(status, ',') from public.marketplace_bids where listing_id = kayak));
  perform pg_temp.check('OA2-unshare: the kayak shows no leader and no standing bid',
    exists (select 1 from public.marketplace_listings where id = kayak and bid_count = 0 and highest_bidder_family_id is null and current_bid_cents = 0),
    (select format('bid_count=%s leader=%s current=%s', bid_count, highest_bidder_family_id, current_bid_cents) from public.marketplace_listings where id = kayak));
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_shelf));
  perform pg_temp.check('N5 respond: O accepts S''s counter on a shelf O can no longer see', not coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  perform pg_temp.check('N5 respond: no order on the shelf, and the thread is closed', not exists (select 1 from public.marketplace_orders where listing_id = shelf)
    and not exists (select 1 from public.marketplace_negotiations where id = t_shelf and status = 'open'), (select status from public.marketplace_negotiations where id = t_shelf));
  res := pg_temp.call(null, format('select public.marketplace_close_auction(%L, now() + interval ''2 days'')', kayak), 'service_role');
  perform pg_temp.check('N6 close: the kayak is not sold to O, who can no longer see it', coalesce(pg_temp.j(res)->>'winner_family_id', '') <> f_o::text, res);
  perform pg_temp.check('N6 close: no order on the kayak', not exists (select 1 from public.marketplace_orders where listing_id = kayak), null);

  -- OA2-unshare across two circles: S unshares the Table and the Canoe from Elm Street only, the way
  -- unshareListingAction deletes (listing, circle, family), in S's own session.
  res := pg_temp.call(u_s, format('with d as (delete from public.marketplace_listing_shares where listing_id in (%L, %L) and circle_id = %L and family_id = %L returning 1) select jsonb_build_object(''unshared'', count(*)) from d', tbl, canoe, circle, f_s));
  perform pg_temp.check('setup: S unshares the table and the canoe from Elm Street (still shared in Oak Lane)', (pg_temp.j(res)->>'unshared')::int = 2, res);
  perform pg_temp.check('OA2-unshare: O, who saw the table only through Elm Street, has its thread closed',
    exists (select 1 from public.marketplace_negotiations where id = t_tbl_o and status = 'expired'),
    (select status from public.marketplace_negotiations where id = t_tbl_o));
  perform pg_temp.check('OA2-unshare: O''s bid on the canoe is retracted',
    exists (select 1 from public.marketplace_bids where listing_id = canoe and bidder_family_id = f_o and status = 'retracted'),
    (select string_agg(bidder_family_id::text || ':' || status, ',') from public.marketplace_bids where listing_id = canoe));
  perform pg_temp.check('OA2-unshare control: T still sees the table through Oak Lane, and its thread stays open',
    exists (select 1 from public.marketplace_negotiations where id = t_tbl_t and status = 'open'),
    (select status from public.marketplace_negotiations where id = t_tbl_t));
  perform pg_temp.check('OA2-unshare control: T''s canoe bid stands and leads at the starting bid, one bid counted',
    exists (select 1 from public.marketplace_listings where id = canoe and highest_bidder_family_id = f_t and bid_count = 1 and current_bid_cents = 1000)
      and exists (select 1 from public.marketplace_bids where listing_id = canoe and bidder_family_id = f_t and status = 'active'),
    (select format('bid_count=%s leader=%s current=%s', bid_count, highest_bidder_family_id, current_bid_cents) from public.marketplace_listings where id = canoe));
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''counter'', 8000)', t_tbl_t));
  perform pg_temp.check('OA2-unshare control: S counters T on the table', coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);

  -- what still lands
  perform pg_temp.check('the bike goes to O, the bidder still in the circle', exists (select 1 from public.marketplace_orders where listing_id = bike and buyer_family_id = f_o and status = 'confirmed'),
    (select string_agg(buyer_family_id::text || ':' || amount_cents, ',') from public.marketplace_orders where listing_id = bike));
  perform pg_temp.check('O''s thread on S''s desk is still open', exists (select 1 from public.marketplace_negotiations where id = t_desk_o and status = 'open'), null);
  res := pg_temp.call(u_s, format('select public.marketplace_negotiation_respond(%L, ''counter'', 4200)', t_desk_o));
  perform pg_temp.check('S counters O on the desk', coalesce((pg_temp.j(res)->>'ok')::boolean, false), res);
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_respond(%L, ''accept'')', t_desk_o));
  perform pg_temp.check('O accepts S''s counter on the desk', coalesce((pg_temp.j(res)->>'ok')::boolean, false) and pg_temp.j(res)->>'status' = 'agreed', res);
end
$probe$;

do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% %  [%]', case when r.ok then 'ok  ' else 'FAIL' end, r.label, coalesce(r.got, '');
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (' || coalesce(r.got, '') || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N5-N7: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N5-N7: % assertions held', (select count(*) from p_result);
end
$verdict$;

rollback;
```

### PROBE (round 2, unchanged): probe-oa2-cascades.sql

```sql
-- PROBE OA2-unshare, the other ways a share goes: a dissolved circle's cascade
-- (the founding family leaves), a deleted listing's cascade, and a deleted
-- family's cascade all succeed with the statement trigger installed, and the
-- dissolve closes what crossed. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.call(who uuid, q text, r text default 'authenticated') returns text language plpgsql as $f$
declare res jsonb; out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claim.role', r, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', r)::text, true);
  execute format('set local role %I', r);
  begin
    execute q into res;
    out := coalesce(res::text, 'null');
  exception when others then out := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  return out;
end $f$;
create function pg_temp.j(res text) returns jsonb language sql immutable as
  $$ select case when res like 'error:%' then jsonb_build_object('error', res) else res::jsonb end $$;
create temp table p_result (seq serial, label text, ok boolean, got text) on commit drop;
create function pg_temp.check(label text, ok boolean, got text) returns void language sql as
  $$ insert into p_result (label, ok, got) values (label, coalesce(ok, false), got) $$;
do $probe$
declare
  f_s uuid := '00000000-0000-4000-8000-00000007e001';
  f_o uuid := '00000000-0000-4000-8000-00000007e003';
  u_s uuid := '00000000-0000-4000-8000-00000007e011';
  u_o uuid := '00000000-0000-4000-8000-00000007e013';
  m_s uuid; m_o uuid;
  circle uuid := '00000000-0000-4000-8000-00000007e0c1';
  vase uuid := gen_random_uuid(); rug uuid := gen_random_uuid(); oar uuid := gen_random_uuid();
  t_vase uuid; t_rug uuid; res text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (u_s, 'oa2c-s@example.test'), (u_o, 'oa2c-o@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (f_s, 'Seller House', u_s), (f_o, 'Other House', u_o) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (f_s, u_s, 'SParent', 'parent', true), (f_o, u_o, 'OParent', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;
  select id into m_s from public.family_members where family_id = f_s and user_id = u_s;
  select id into m_o from public.family_members where family_id = f_o and user_id = u_o;
  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by) values (circle, 'Pine Road', 'OA2CASC1', f_s, u_s);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values (circle, f_s, 'Seller House', 'owner'), (circle, f_o, 'Other House', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, price_cents) values
    (vase, f_s, m_s, u_s, 'Vase', 'sell', 'available', 2000), (rug, f_s, m_s, u_s, 'Rug', 'sell', 'available', 3000);
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status, sale_format, starting_bid_cents, auction_ends_at) values
    (oar, f_s, m_s, u_s, 'Oar', 'sell', 'available', 'auction', 1000, now() + interval '1 day');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values (vase, circle, f_s), (rug, circle, f_s), (oar, circle, f_s);
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 1500)', vase, m_o, f_o));
  t_vase := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_o, format('select public.marketplace_negotiation_offer(%L, %L, %L, 2500)', rug, m_o, f_o));
  t_rug := (pg_temp.j(res)->>'negotiation_id')::uuid;
  res := pg_temp.call(u_o, format('select public.marketplace_place_bid(%L, %L, %L, 1500)', oar, m_o, f_o));
  if t_vase is null or t_rug is null then raise exception 'probe fixture: no thread opened (%)', res; end if;

  -- a deleted listing: its shares, threads and bids cascade with it
  delete from public.marketplace_listings where id = rug;
  perform pg_temp.check('deleting a shared listing with an open thread succeeds; the thread cascades with it',
    not exists (select 1 from public.marketplace_negotiations where id = t_rug), null);
  -- the founding family leaves: the circle and every share in it cascade
  res := pg_temp.call(u_s, format('select jsonb_build_object(''left'', public.marketplace_leave_circle(%L, %L)::text)', f_s, circle));
  perform pg_temp.check('the founding family leaves (the circle and its shares cascade)', res not like 'error:%', res);
  perform pg_temp.check('the dissolve closed O''s thread on the vase', exists (select 1 from public.marketplace_negotiations where id = t_vase and status = 'expired'),
    (select status from public.marketplace_negotiations where id = t_vase));
  perform pg_temp.check('the dissolve retracted O''s bid on the oar', exists (select 1 from public.marketplace_bids where listing_id = oar and bidder_family_id = f_o and status = 'retracted'),
    (select string_agg(status, ',') from public.marketplace_bids where listing_id = oar));
  -- a deleted family: its listings and their shares cascade
  delete from public.families where id = f_s;
  perform pg_temp.check('the seller family and its listings are gone', not exists (select 1 from public.marketplace_listings where family_id = f_s), null);
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% %  [%]', case when r.ok then 'ok  ' else 'FAIL' end, r.label, coalesce(r.got, '');
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (' || coalesce(r.got, '') || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe OA2 cascades: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe OA2 cascades: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

## OWNER ACTION #3 (N12, N12-purchased, N12-purchased/db-unbuy)

OWNER ACTION #3 (N12, N12-purchased, N12-purchased/db-unbuy). SQL, to apply as one migration. It replaces round 3's #3:
- (a) is the reviewer's candidate (rv-rls-sweep3-1/mine/oa3-candidate-r4.sql) with one tightening;
- (b) is unchanged.

WHY. Round 3's (a') refused only a new claim. Measured with round 3's #3 wrapped (rolled back) on copy A, as ParentA (role authenticated):
- `update public.wishlist_items set is_purchased = false where id = <released Telescope> and family_id = <fam>` got 1;
- the same with `claimed_by = null, claimed_at = null, is_purchased = false` got 1;
- on the claimer_gone Kite (bought by Gran2, then soft-removed), the release that keeps it bought, `set claimed_by = null, claimed_at = null`, was refused (42501 'claim the gift before marking it bought');
- the same release with is_purchased = false got 1.
probe-n12-unbuy-r4 had 4 FAIL, and probe-n12-r4 had 2 FAIL.

The app half is already closed:
- canToggleClaim (lib/wishlists/gifts.ts:43);
- toggleClaim (components/modules/wishlists-module.tsx:117; its release body at :121 is `{ claimed_by: null, claimed_at: null, is_purchased: false }`);
- 'Mark bought' only for the claimer (:221-224).
lib/wishlists/release-claims.ts:31-33 releases with the service role, keeping is_purchased.

THE GUARD CHANGE:
- (a'): `if old.is_purchased and (old.claimed_by is null or claimer_gone) and (new.claimed_by is not null or not new.is_purchased or new.claimed_at is not null) then raise exception 'this gift is already bought' using errcode = '42501'`.
- The 'claim before bought' check gains `and not (old.is_purchased and (old.claimed_by is null or claimer_gone))`.

MY TIGHTENING over the candidate is `or new.claimed_at is not null`. With the candidate verbatim (wrapped and rolled back):
- probe-n12-r4 7/7, probe-n12-rebuy 3/3, probe-n12-repair 4/4;
- probe-n12-unbuy-r4 11 of 13. ParentA's `update public.wishlist_items set claimed_at = now() where id = <released Telescope> and family_id = <fam>` got 1, which round 3 and 0481 refused (the same line under round 3: 'refused'). `set claimed_by = null` on the claimer_gone Kite, which leaves its claim time, also got 1.
- Both leave a claim time on a gift nobody claims. The tightening refuses them and changes no line the reviewer measured.

Unchanged choices:
- Whether a manager may un-buy is the owner's call; the guard refuses everyone but the claimer.
- The claimer's own undo stays allowed (control 'ParentA releases and un-buys the Drum they claimed and bought': 1).

PROBES. probe-n12.sql L60-61 is replaced by probe-n12-r4.sql: the keep-bought release wants ok, and the un-buying release wants refused.

On copy A (seed-n12-claims committed):
- before: probe-n12-r4 2 FAIL, probe-n12-repair 2 FAIL, probe-n12-rebuy 2 FAIL, probe-n12-unbuy-r4 3 FAIL;
- #3 r4: (b) UPDATE 2, then UPDATE 0;
- after: 7/7, 4/4, 3/3 and 13/13.

On copy B (fresh, plus the seed): the same counts before and after, and UPDATE 2, then 0.

Inline below: probe-n12-r4 (self-contained), and seed-n12-claims with probe-n12-unbuy-r4 (the reviewer's rv-n12-unbuy plus three lines).

### OWNER ACTION #3 r4, full migration: oa3-fix-n12-r4.sql

```sql
-- N12: a gift claimed by a member who has since been removed (soft delete:
-- family_members.is_active = false) is released, not held for ever.
-- 0481's wishlist_item_write_guard refused every claim change unless the
-- caller IS the claimer, which a removed member no longer is, and the
-- ON DELETE SET NULL it allows for ([FIX 7]) never fires for a soft delete.

-- (a) A claim whose claimer is no longer an active member of the family may be
--     released by the givers still in it, or taken unless the gift is bought
--     (a'); a bought one is released with is_purchased kept, never un-bought,
--     and a bought gift with no claimer takes no claim, no un-buying and no
--     claim time. Everything else is 0481's.
create or replace function public.wishlist_item_write_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  content_changed boolean;
  claim_changed boolean;
  claimer_gone boolean;
begin
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then return new; end if;
  -- [FIX 7] an ON DELETE SET NULL from family_members (claimed_by) or auth.users (created_by) arrives here
  -- as an UPDATE fired from the RI trigger; removing a member who had claimed a gift must not raise.
  if pg_trigger_depth() > 1 then return new; end if;
  content_changed := new.family_id is distinct from old.family_id or new.member_id is distinct from old.member_id
    or new.title is distinct from old.title or new.url is distinct from old.url or new.price is distinct from old.price
    or new.priority is distinct from old.priority or new.notes is distinct from old.notes or new.created_by is distinct from old.created_by;
  claim_changed := new.claimed_by is distinct from old.claimed_by or new.claimed_at is distinct from old.claimed_at
    or new.is_purchased is distinct from old.is_purchased;
  if content_changed and not (public.is_self_member(old.member_id) or public.can_manage_family(old.family_id)) then
    raise exception 'only the wish''s owner can change it' using errcode = '42501';
  end if;
  if claim_changed then
    if public.is_self_member(old.member_id) then
      raise exception 'you cannot claim your own wish' using errcode = '42501';
    end if;
    claimer_gone := old.claimed_by is not null and not exists (
      select 1 from public.family_members fm
       where fm.id = old.claimed_by and fm.family_id = old.family_id and fm.is_active);
    if old.claimed_by is not null and not public.is_self_member(old.claimed_by) and not claimer_gone then
      raise exception 'this gift is claimed by someone else' using errcode = '42501';
    end if;
    -- (a') N12-purchased: a gift bought by a claimer who is gone (removed, so
    -- released by (b) or the app, or deleted, so SET NULL) stays bought: no
    -- new claim on it and no un-buying of it, either of which would put a
    -- present already bought back on the list (lib/wishlists/gifts.ts
    -- canToggleClaim no longer offers the claim). Releasing it with
    -- is_purchased kept, as release-claims.ts and (b) do (claimed_by and
    -- claimed_at both cleared), stays allowed, so the 'claim before bought'
    -- check below does not apply to that release. A claim time with no
    -- claimer is refused, as 0481's 'claim before bought' check refused it.
    if old.is_purchased and (old.claimed_by is null or claimer_gone)
       and (new.claimed_by is not null or not new.is_purchased or new.claimed_at is not null) then
      raise exception 'this gift is already bought' using errcode = '42501';
    end if;
    if new.claimed_by is not null and not public.is_self_member(new.claimed_by) then
      raise exception 'a claim is made for yourself' using errcode = '42501';
    end if;
    if new.is_purchased and new.claimed_by is null
       and not (old.is_purchased and (old.claimed_by is null or claimer_gone)) then
      raise exception 'claim the gift before marking it bought' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- (b) One-time repair. The claims that removed members hold today are
--     released, as the app's removal now does for every new removal
--     (lib/wishlists/release-claims.ts). It matches the hard delete's
--     ON DELETE SET NULL on claimed_by: the claimer is cleared and
--     is_purchased is kept. It also clears claimed_at, the time of a claim
--     that no longer exists. So a gift the removed member already bought
--     still reads 'Bought' and is not offered again, and an unbought claim
--     goes back on the list. Re-runnable: a second run matches nothing.
update public.wishlist_items w
   set claimed_by = null, claimed_at = null
 where w.claimed_by is not null
   and not exists (select 1 from public.family_members fm
                    where fm.id = w.claimed_by and fm.family_id = w.family_id and fm.is_active);
```

### PROBE (replaces probe-n12.sql; self-contained): probe-n12-r4.sql

```sql
-- PROBE N12: a removed member's gift claim can be released and re-claimed by
-- the givers still in the family; an active member's claim still cannot. Rolled back.
\set ON_ERROR_STOP on
begin;

create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' end);
end $f$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000008b000';
  uP uuid := '00000000-0000-4000-8000-00000008b001';
  uK uuid := '00000000-0000-4000-8000-00000008b002';
  uS uuid := '00000000-0000-4000-8000-00000008b003';
  uC uuid := '00000000-0000-4000-8000-00000008b004';
  mP uuid; mK uuid; mS uuid; mC uuid;
  wGone uuid; wGone2 uuid; wActive uuid;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n12-p@example.test'), (uK, 'n12-k@example.test'), (uS, 'n12-s@example.test'), (uC, 'n12-c@example.test') on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'N12 probe') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'ParentA', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'KidA', 'child', true) returning id into mK;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uS, 'SibA', 'child', true) returning id into mS;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'CarerA', 'caregiver', true) returning id into mC;
  insert into public.wishlist_items (family_id, member_id, title, created_by, claimed_by, claimed_at, is_purchased) values (fam, mS, 'Telescope', uS, mC, now(), true) returning id into wGone;
  insert into public.wishlist_items (family_id, member_id, title, created_by, claimed_by, claimed_at) values (fam, mS, 'Kite', uS, mC, now()) returning id into wGone2;
  insert into public.wishlist_items (family_id, member_id, title, created_by, claimed_by, claimed_at) values (fam, mS, 'Lego', uS, mP, now()) returning id into wActive;
  -- CarerA is removed the way the app removes a member: a soft delete.
  update public.family_members set is_active = false where id = mC;

  perform pg_temp.p_expect('parent releases the gift a removed member claimed and bought, keeping it bought (as release-claims.ts and (b) do)',
    pg_temp.p_try(uP, format('update public.wishlist_items set claimed_by = null, claimed_at = null where id = %L', wGone)), 'ok');
  perform pg_temp.p_expect('parent releases AND un-buys the gift a removed member bought (puts it back on the list)',
    pg_temp.p_try(uP, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L', wGone)), 'refused');
  perform pg_temp.p_expect('another giver claims a gift a removed member had claimed',
    pg_temp.p_try(uK, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L', mK, wGone2)), 'ok');
  -- what stays refused
  perform pg_temp.p_expect('a giver takes over an ACTIVE member''s claim',
    pg_temp.p_try(uK, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L', mK, wActive)), 'refused');
  perform pg_temp.p_expect('a giver releases an ACTIVE member''s claim',
    pg_temp.p_try(uK, format('update public.wishlist_items set claimed_by = null, claimed_at = null where id = %L', wActive)), 'refused');
  perform pg_temp.p_expect('the wish''s owner touches the claim on their own wish',
    pg_temp.p_try(uS, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L', wGone)), 'refused');
  perform pg_temp.p_expect('a giver claims a removed member''s gift in someone else''s name',
    pg_temp.p_try(uK, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L', mP, wGone2)), 'refused');
end
$probe$;

do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N12: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N12: % assertions held', (select count(*) from p_result);
end
$verdict$;

rollback;
```

### PROBE SEED, committed before #3: seed-n12-claims.sql

```sql
-- SEED for probe-n12-repair.sql. COMMITTED on purpose: claims a member held
-- when they were removed (soft delete) before owner action #3 exists.
-- Fixed ids (…0009b…). Run once, before owner action #3.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000009b001', 'n12r-parent@example.test'),
  ('00000000-0000-4000-8000-00000009b003', 'n12r-sib@example.test');
insert into public.families (id, name) values ('00000000-0000-4000-8000-00000009b000', 'N12 repair');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8000-00000009b0a1', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b001', 'ParentA', 'parent', true),
  ('00000000-0000-4000-8000-00000009b0a3', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b003', 'SibA', 'child', true),
  ('00000000-0000-4000-8000-00000009b0a4', '00000000-0000-4000-8000-00000009b000', null, 'CarerA', 'caregiver', true),
  ('00000000-0000-4000-8000-00000009b0a5', '00000000-0000-4000-8000-00000009b000', null, 'Gran', 'adult', true);
insert into public.wishlist_items (id, family_id, member_id, title, claimed_by, claimed_at, is_purchased) values
  -- claimed and bought by CarerA, who is then removed
  ('00000000-0000-4000-8000-00000009b0e1', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b0a3', 'Telescope', '00000000-0000-4000-8000-00000009b0a4', now(), true),
  -- claimed, not bought, by CarerA
  ('00000000-0000-4000-8000-00000009b0e2', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b0a3', 'Puzzle', '00000000-0000-4000-8000-00000009b0a4', now(), false),
  -- claimed by ParentA, who stays
  ('00000000-0000-4000-8000-00000009b0e3', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b0a3', 'Lego', '00000000-0000-4000-8000-00000009b0a1', now(), false),
  -- claimed and bought by Gran, whom the probe hard-deletes (the SET NULL to match)
  ('00000000-0000-4000-8000-00000009b0e4', '00000000-0000-4000-8000-00000009b000', '00000000-0000-4000-8000-00000009b0a3', 'Book', '00000000-0000-4000-8000-00000009b0a5', now(), true);
-- CarerA is removed the way the app removes a member (REMOVED_MEMBER_PATCH).
update public.family_members set is_active = false where id = '00000000-0000-4000-8000-00000009b0a4';
commit;
```

### PROBE (N12-purchased/db-unbuy gate): probe-n12-unbuy-r4.sql

```sql
-- PROBE N12-purchased/db-unbuy (round 4; the reviewer's rv-n12-unbuy.sql plus
-- three lines): after owner action #3, can a giver un-buy a released bought
-- gift directly (no claim), or stamp a claim time on it? Needs
-- seed-n12-claims.sql committed. Each attempt is undone. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009b000';
  uParent uuid := '00000000-0000-4000-8000-00000009b001';
  uSib uuid := '00000000-0000-4000-8000-00000009b003';
  mParent uuid := '00000000-0000-4000-8000-00000009b0a1';
  telescope uuid := '00000000-0000-4000-8000-00000009b0e1';
  lego uuid := '00000000-0000-4000-8000-00000009b0e3';
begin
  perform pg_temp.p_expect('fixture: Telescope state', (select format('claimed_by=%s is_purchased=%s', coalesce(claimed_by::text,'null'), is_purchased) from public.wishlist_items where id = telescope), 'claimed_by=null is_purchased=t');
  perform pg_temp.p_expect('a giver (ParentA) un-buys the released bought Telescope directly: update set is_purchased=false',
    pg_temp.p_try(uParent, format('update public.wishlist_items set is_purchased = false where id = %L and family_id = %L', telescope, fam)), 'refused');
  perform pg_temp.p_expect('a giver (ParentA) releases-and-unbuys in one write: set claimed_by=null, claimed_at=null, is_purchased=false (toggleClaim''s release body)',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L and family_id = %L', telescope, fam)), 'refused');
  perform pg_temp.p_expect('the wish''s owner (SibA) un-buys their own wish',
    pg_temp.p_try(uSib, format('update public.wishlist_items set is_purchased = false where id = %L and family_id = %L', telescope, fam)), 'refused');
  perform pg_temp.p_expect('control: ParentA marks their own claimed Lego bought (togglePurchased)',
    pg_temp.p_try(uParent, format('update public.wishlist_items set is_purchased = true where id = %L and family_id = %L', lego, fam)), 'ok');
  perform pg_temp.p_expect('control: ParentA releases their own Lego (toggleClaim release body)',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L and family_id = %L', lego, fam)), 'ok');
  perform pg_temp.p_expect('a giver (ParentA) stamps a claim time on the released bought Telescope, with no claimer',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_at = now() where id = %L and family_id = %L', telescope, fam)), 'refused');
  perform pg_temp.p_expect('after the attempts, Telescope state', (select format('claimed_by=%s is_purchased=%s', coalesce(claimed_by::text,'null'), is_purchased) from public.wishlist_items where id = telescope), 'claimed_by=null is_purchased=t');
  -- The claimer_gone variant: a gift claimed and bought by a member who is then removed (soft) and whose claim
  -- was never released (a removal before the app's release, or (b) not yet run).
  insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
    values ('00000000-0000-4000-8000-00000009b0a9', fam, null, 'Gran2', 'adult', true);
  insert into public.wishlist_items (id, family_id, member_id, title, claimed_by, claimed_at, is_purchased)
    values ('00000000-0000-4000-8000-00000009b0e9', fam, '00000000-0000-4000-8000-00000009b0a3', 'Kite', '00000000-0000-4000-8000-00000009b0a9', now(), true);
  update public.family_members set is_active = false where id = '00000000-0000-4000-8000-00000009b0a9';
  perform pg_temp.p_expect('claimer_gone: a giver claims the Kite its removed claimer bought ((a''))',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L and family_id = %L', mParent, '00000000-0000-4000-8000-00000009b0e9', fam)), 'refused');
  perform pg_temp.p_expect('claimer_gone: a giver releases the Kite keeping it bought (as release-claims.ts does)',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null, claimed_at = null where id = %L and family_id = %L', '00000000-0000-4000-8000-00000009b0e9', fam)), 'ok');
  perform pg_temp.p_expect('claimer_gone: a giver releases AND un-buys the Kite in one write',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L and family_id = %L', '00000000-0000-4000-8000-00000009b0e9', fam)), 'refused');
  perform pg_temp.p_expect('claimer_gone: a giver clears the Kite''s claimer but leaves its claim time',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null where id = %L and family_id = %L', '00000000-0000-4000-8000-00000009b0e9', fam)), 'refused');
  -- The claimer's own undo of a gift they bought (round 3's observation (b)) stays allowed.
  insert into public.wishlist_items (id, family_id, member_id, title, claimed_by, claimed_at, is_purchased)
    values ('00000000-0000-4000-8000-00000009b0ea', fam, '00000000-0000-4000-8000-00000009b0a3', 'Drum', mParent, now(), true);
  perform pg_temp.p_expect('control: ParentA releases and un-buys the Drum they claimed and bought (toggleClaim''s release body)',
    pg_temp.p_try(uParent, format('update public.wishlist_items set claimed_by = null, claimed_at = null, is_purchased = false where id = %L and family_id = %L', '00000000-0000-4000-8000-00000009b0ea', fam)), 'ok');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
  end loop;
  select count(*) into bad from p_result where not ok;
  raise notice 'reviewer verdict: % of % held', (select count(*) from p_result) - bad, (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (round 2, unchanged): probe-n12-repair.sql

```sql
-- PROBE N12-purchased: owner action #3 (b) releases a removed member's claims
-- the way the hard delete's ON DELETE SET NULL does. A bought gift stays
-- bought; an unbought claim goes back on the list; an active member's claim is
-- untouched. Needs seed-n12-claims.sql. Rolled back.
\set ON_ERROR_STOP on
begin;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got, got is not distinct from want);
end $f$;
create function pg_temp.w(wid uuid) returns text language sql as $f$
  select coalesce((select format('claimed_by=%s claimed_at=%s is_purchased=%s',
    coalesce(claimed_by::text, 'null'), case when claimed_at is null then 'null' else 'set' end, case when is_purchased then 'true' else 'false' end)
    from public.wishlist_items where id = wid), 'missing')
$f$;
do $probe$
declare
  telescope uuid := '00000000-0000-4000-8000-00000009b0e1';
  puzzle uuid := '00000000-0000-4000-8000-00000009b0e2';
  lego uuid := '00000000-0000-4000-8000-00000009b0e3';
  book uuid := '00000000-0000-4000-8000-00000009b0e4';
  gran uuid := '00000000-0000-4000-8000-00000009b0a5';
begin
  if not exists (select 1 from public.wishlist_items where id = telescope) then
    raise exception 'probe fixture: seed-n12-claims.sql has not been run';
  end if;
  -- The hard delete, for comparison: Gran's member row goes, the FK's SET NULL runs.
  delete from public.family_members where id = gran;
  perform pg_temp.p_expect('the hard delete''s SET NULL keeps a bought gift bought (Book)', pg_temp.w(book), 'claimed_by=null claimed_at=set is_purchased=true');
  perform pg_temp.p_expect('the repair releases the removed carer''s bought Telescope and keeps it bought, as SET NULL does', pg_temp.w(telescope), 'claimed_by=null claimed_at=null is_purchased=true');
  perform pg_temp.p_expect('the repair puts the removed carer''s unbought Puzzle back on the list', pg_temp.w(puzzle), 'claimed_by=null claimed_at=null is_purchased=false');
  perform pg_temp.p_expect('the active parent''s claim on the Lego is untouched', pg_temp.w(lego), 'claimed_by=00000000-0000-4000-8000-00000009b0a1 claimed_at=set is_purchased=false');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N12 repair: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N12 repair: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (round 3, unchanged): probe-n12-rebuy.sql

```sql
-- PROBE N12-purchased (round 3): after owner action #3, the released bought Telescope
-- (claimed_by null, is_purchased true; seed-n12-claims.sql, then (b)) is closed to a new
-- claim, so the screen's claim-then-release (wishlists-module.tsx:116-125) cannot reset
-- is_purchased. The released unbought Puzzle stays claimable. Sent as ParentA, a giver,
-- exactly as toggleClaim sends them. Each attempt is undone. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009b000';
  uParent uuid := '00000000-0000-4000-8000-00000009b001';
  mParent uuid := '00000000-0000-4000-8000-00000009b0a1';
  telescope uuid := '00000000-0000-4000-8000-00000009b0e1';
  puzzle uuid := '00000000-0000-4000-8000-00000009b0e2';
  claim text := 'update public.wishlist_items set claimed_by = %L, claimed_at = now() where id = %L and family_id = %L';
begin
  if not exists (select 1 from public.wishlist_items where id = telescope) then
    raise exception 'probe fixture: seed-n12-claims.sql has not been run';
  end if;
  perform pg_temp.p_expect('fixture: the Telescope is released and still bought',
    (select format('claimed=%s purchased=%s', claimed_by is not null, is_purchased) from public.wishlist_items where id = telescope), 'claimed=f purchased=t');
  perform pg_temp.p_expect('a giver claims the released bought Telescope (its release would reset is_purchased)',
    pg_temp.p_try(uParent, format(claim, mParent, telescope, fam)), 'refused');
  perform pg_temp.p_expect('control: a giver claims the released unbought Puzzle',
    pg_temp.p_try(uParent, format(claim, mParent, puzzle, fam)), 'ok');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N12 rebuy: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N12 rebuy: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

## OWNER ACTION #4 (N4, N4-sibling, N4-sibling/non-creator)

OWNER ACTION #4 (N4, N4-sibling, N4-sibling/non-creator). SQL, alternative (ii), RECOMMENDED. UNCHANGED from round 3.

The SQL:
- a restrictive insert policy, not_a_caregiver;
- restrictive update and delete policies, manager_or_creator: `family_role(family_id) is distinct from 'caregiver' and (can_manage_family(family_id) or created_by = auth.uid())`;
- it drops (i)'s update and delete policies if they are present.

Why: 0481 keeps expense_splits writes at is_family_member, while expense_split_shares_delete (0481 L157-161) allows only a manager or the split's creator, and a split's delete cascades to its shares.

probe-n4-teen before #4, as the teen (role authenticated):
- `delete from expense_split_shares where split_id = <parent's split>` got 0;
- `delete from expense_splits where id = <parent's split> and family_id = <fam>` got 1;
- `update expense_splits set total_cents = 1, paid_by = <teen> where id = <parent's split>` got 1.

The app matches (ii):
- the Trash is offered only to a manager or the creator (components/modules/expenses-module.tsx:58, rendered at :252);
- nothing edits a split in place;
- the deletes at :161 and :190 name family_id and read the row back.

The settle sibling is closed in the app by this round's commit:
- settlesShare (:65-66, rendered at :259) follows expense_split_shares_update's USING;
- rv-n4-settle, as the teen: `update expense_split_shares set settled = true, settled_at = now() where id = <the parent's own share on the parent's split> and family_id = <fam>` got 0; the child's on the teen's own share got 0; the controls each got 1.

RELEASE STEP (CI's, not editable here): add 'expense_splits' to `recorded` on the '-- rls sweep 2026-10-10 (0481)' line of docs/audit/gated-write-tables-check.sql, in the same release:
`'dashboard_layout_events', 'dining_out', 'expense_split_shares', 'expense_splits', 'family_announcements', 'family_dates',`.
tests/a-filtered-delete-is-not-a-deletion.test.ts reads GATED from that list, and both write sites already comply.

PROBES:
- probe-n4-r3 (19, inline below): 7 FAIL before; 19 of 19 after (ii) applied twice, on A and on B.
- probe-n4-teen (3): 2 FAIL before, 3 of 3 after.
- rv-n4-settle: 5 of 5 before and after.

Remaining alternatives, unchanged:
- (iii): record a non-creator's split delete as intended.
- Caregiver settling: in expense_split_shares_update, move `family_role(family_id) not in ('guest','caregiver')` so it wraps only the creator/manager arm, keeping `is distinct from 'guest'` outside and the WITH CHECK containing the USING. Then extend settlesShare.

### OWNER ACTION #4 (ii), full SQL (unchanged from round 3): oa4-ii-n4-expense-splits-r4.sql

```sql
-- N4 + N4-sibling + N4-sibling/non-creator, owner action #4 alternative (ii),
-- RECOMMENDED: expense_splits is written as 0481 writes its shares.
--
-- 0481 L265-280 keeps expense_splits_insert, _update and _delete at
-- is_family_member (a guest is held only by 0464's trigger), while its share
-- policies are narrower:
-- - expense_split_shares_insert and _update exclude a caregiver;
-- - expense_split_shares_delete allows only a manager, or the non-guest,
--   non-caregiver member who created the split.
-- Deleting a split deletes its shares (expense_split_shares.split_id is ON
-- DELETE CASCADE). So any member but a guest could delete any household
-- split, and with it the shares 0481 refuses them directly, and could
-- rewrite its total and payer. Alternative (i) closed that for a caregiver
-- only; a teen or a child still could (probe-n4-r3.sql).
--
-- The screen asks no more than this: Split is offered to every member but a
-- caregiver; the Trash only to a manager or to the split's creator
-- (components/modules/expenses-module.tsx, removesSplit); nothing edits a
-- split in place. The failed-split rollback (:153) deletes the caller's own
-- split. RESTRICTIVE, so the permissive policies stay as they are.
do $$
declare
  not_a_caregiver text := '(public.family_role(family_id) is distinct from ''caregiver''::public.member_role)';
  manager_or_creator text := '(public.family_role(family_id) is distinct from ''caregiver''::public.member_role'
    || ' and (public.can_manage_family(family_id) or created_by = auth.uid()))';
begin
  if to_regclass('public.expense_splits') is null then return; end if;
  if to_regprocedure('public.family_role(uuid)') is null then
    raise exception 'family_role(uuid) is missing';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception 'can_manage_family(uuid) is missing';
  end if;
  execute 'drop policy if exists expense_splits_insert_not_a_caregivers on public.expense_splits';
  execute 'create policy expense_splits_insert_not_a_caregivers on public.expense_splits as restrictive for insert to authenticated with check ' || not_a_caregiver;
  -- (i)'s caregiver-only update and delete guards give way to (ii)'s.
  execute 'drop policy if exists expense_splits_update_not_a_caregivers on public.expense_splits';
  execute 'drop policy if exists expense_splits_delete_not_a_caregivers on public.expense_splits';
  execute 'drop policy if exists expense_splits_update_manager_or_creator on public.expense_splits';
  execute 'create policy expense_splits_update_manager_or_creator on public.expense_splits as restrictive for update to authenticated using ' || manager_or_creator || ' with check ' || manager_or_creator;
  execute 'drop policy if exists expense_splits_delete_manager_or_creator on public.expense_splits';
  execute 'create policy expense_splits_delete_manager_or_creator on public.expense_splits as restrictive for delete to authenticated using ' || manager_or_creator;
end $$;
```

### PROBE: probe-n4-r3.sql

```sql
-- PROBE N4 + N4-sibling + N4-sibling/non-creator (round 3): a caregiver reads
-- the household's splits and writes none of them; a teen or a child writes
-- only the splits they created, as 0481's expense_split_shares_delete rules
-- for the shares a split's delete cascades; a manager writes every split; a
-- guest stays refused. Alternative (i) passes the first 12 lines only;
-- alternative (ii) passes all. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      -- every attempt is undone, so each one starts from the same fixture
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create function pg_temp.p_count(who uuid, q text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q into n;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return n::text;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009c000';
  uP uuid := '00000000-0000-4000-8000-00000009c001';
  uT uuid := '00000000-0000-4000-8000-00000009c003';
  uC uuid := '00000000-0000-4000-8000-00000009c005';
  uG uuid := '00000000-0000-4000-8000-00000009c006';
  uA uuid := '00000000-0000-4000-8000-00000009c002';
  uK uuid := '00000000-0000-4000-8000-00000009c004';
  mP uuid; mT uuid; mC uuid; mG uuid; mA uuid; mK uuid;
  split uuid := '00000000-0000-4000-8000-00000009c0e1';
  split_t uuid := '00000000-0000-4000-8000-00000009c0e2';
  ins text := 'insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (%L, %L, %s, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n4-p@example.test'), (uT, 'n4-t@example.test'), (uC, 'n4-c@example.test'), (uG, 'n4-g@example.test'),
    (uA, 'n4-a@example.test'), (uK, 'n4-k@example.test') on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'N4 probe') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Ada', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Guest', 'guest', true) returning id into mG;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'Bo', 'adult', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.expense_splits (id, family_id, description, total_cents, paid_by, created_by) values
    (split, fam, 'Groceries', 4000, mP, uP), (split_t, fam, 'Pizza', 1200, mT, uT);
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values
    (fam, split, mP, 2000), (fam, split, mC, 2000), (fam, split_t, mT, 600), (fam, split_t, mC, 600);

  -- the caregiver reads
  perform pg_temp.p_expect('caregiver reads the household''s splits', pg_temp.p_count(uC, format('select count(*) from public.expense_splits where family_id = %L', fam)), '2');
  perform pg_temp.p_expect('caregiver reads the shares', pg_temp.p_count(uC, format('select count(*) from public.expense_split_shares where family_id = %L', fam)), '4');
  -- and writes nothing
  perform pg_temp.p_expect('caregiver deletes a split''s shares directly (0481 already refuses)', pg_temp.p_try(uC, format('delete from public.expense_split_shares where split_id = %L', split)), 'refused');
  perform pg_temp.p_expect('caregiver deletes the parent''s split, which would cascade its shares', pg_temp.p_try(uC, format('delete from public.expense_splits where id = %L', split)), 'refused');
  perform pg_temp.p_expect('caregiver rewrites the parent''s split (total and payer)', pg_temp.p_try(uC, format('update public.expense_splits set total_cents = 1, paid_by = %L where id = %L', mC, split)), 'refused');
  perform pg_temp.p_expect('caregiver inserts a split with no shares (N4)', pg_temp.p_try(uC, format(ins, fam, 'Sitter lunch', 900, mC, uC)), 'refused');
  -- the guest stays refused (0464's trigger)
  perform pg_temp.p_expect('guest deletes the parent''s split', pg_temp.p_try(uG, format('delete from public.expense_splits where id = %L', split)), 'refused');
  -- the flows that stay
  perform pg_temp.p_expect('parent deletes their split (its shares go with it)', pg_temp.p_try(uP, format('delete from public.expense_splits where id = %L', split)), 'ok');
  perform pg_temp.p_expect('parent corrects the teen''s split', pg_temp.p_try(uP, format('update public.expense_splits set total_cents = 1300 where id = %L', split_t)), 'ok');
  perform pg_temp.p_expect('teen starts a split', pg_temp.p_try(uT, format(ins, fam, 'Movie', 2400, mT, uT)), 'ok');
  -- (also what the failed-split rollback sends, expenses-module.tsx:153: the caller's own split)
  perform pg_temp.p_expect('teen deletes their own split', pg_temp.p_try(uT, format('delete from public.expense_splits where id = %L', split_t)), 'ok');
  perform pg_temp.p_expect('teen settles their own share', pg_temp.p_try(uT, format('update public.expense_split_shares set settled = true where split_id = %L and member_id = %L', split_t, mT)), 'ok');
  -- Round 3 (N4-sibling/non-creator): a teen or a child and the splits they did not create.
  perform pg_temp.p_expect('teen deletes the parent''s split''s shares directly (0481 already refuses: manager or the split''s creator)', pg_temp.p_try(uT, format('delete from public.expense_split_shares where split_id = %L', split)), 'refused');
  perform pg_temp.p_expect('teen deletes the parent''s split, which would cascade those shares (removeSplit, expenses-module.tsx:182)', pg_temp.p_try(uT, format('delete from public.expense_splits where id = %L and family_id = %L', split, fam)), 'refused');
  perform pg_temp.p_expect('teen rewrites the parent''s split (total and payer)', pg_temp.p_try(uT, format('update public.expense_splits set total_cents = 1, paid_by = %L where id = %L', mT, split)), 'refused');
  perform pg_temp.p_expect('child deletes the teen''s split', pg_temp.p_try(uK, format('delete from public.expense_splits where id = %L and family_id = %L', split_t, fam)), 'refused');
  perform pg_temp.p_expect('teen hands their own split to the parent (created_by)', pg_temp.p_try(uT, format('update public.expense_splits set created_by = %L where id = %L', uP, split_t)), 'refused');
  -- what stays
  perform pg_temp.p_expect('teen corrects their own split', pg_temp.p_try(uT, format('update public.expense_splits set total_cents = 1300 where id = %L', split_t)), 'ok');
  perform pg_temp.p_expect('an adult (a manager) deletes the teen''s split', pg_temp.p_try(uA, format('delete from public.expense_splits where id = %L and family_id = %L', split_t, fam)), 'ok');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N4 r3: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N4 r3: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (reviewer, round 3): probe-n4-teen.sql

```sql
-- PROBE N4 + N4-sibling: a caregiver reads the household's splits and writes
-- none of them; a parent's and a teen's split flows are unchanged; a guest
-- stays refused. Rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      -- every attempt is undone, so each one starts from the same fixture
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create function pg_temp.p_count(who uuid, q text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q into n;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return n::text;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009c000';
  uP uuid := '00000000-0000-4000-8000-00000009c001';
  uT uuid := '00000000-0000-4000-8000-00000009c003';
  uC uuid := '00000000-0000-4000-8000-00000009c005';
  uG uuid := '00000000-0000-4000-8000-00000009c006';
  mP uuid; mT uuid; mC uuid; mG uuid;
  split uuid := '00000000-0000-4000-8000-00000009c0e1';
  split_t uuid := '00000000-0000-4000-8000-00000009c0e2';
  ins text := 'insert into public.expense_splits (family_id, description, total_cents, paid_by, created_by) values (%L, %L, %s, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n4-p@example.test'), (uT, 'n4-t@example.test'), (uC, 'n4-c@example.test'), (uG, 'n4-g@example.test') on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'N4 probe') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Ada', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Guest', 'guest', true) returning id into mG;
  insert into public.expense_splits (id, family_id, description, total_cents, paid_by, created_by) values
    (split, fam, 'Groceries', 4000, mP, uP), (split_t, fam, 'Pizza', 1200, mT, uT);
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values
    (fam, split, mP, 2000), (fam, split, mC, 2000), (fam, split_t, mT, 600), (fam, split_t, mC, 600);

  -- Reviewer: the same cascade, from a teen, on the PARENT's split (the Trash expenses-module.tsx:239-244 still offers a teen or child on every split).
  perform pg_temp.p_expect('teen deletes the parent''s split''s shares directly (expense_split_shares_delete: manager or the split''s creator)', pg_temp.p_try(uT, format('delete from public.expense_split_shares where split_id = %L', split)), 'refused');
  perform pg_temp.p_expect('teen deletes the parent''s split, which cascades the same shares (removeSplit, expenses-module.tsx:177)', pg_temp.p_try(uT, format('delete from public.expense_splits where id = %L and family_id = %L', split, fam)), 'refused');
  perform pg_temp.p_expect('teen rewrites the parent''s split (total and payer)', pg_temp.p_try(uT, format('update public.expense_splits set total_cents = 1, paid_by = %L where id = %L', mT, split)), 'refused');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'reviewer probe N4 teen: % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK reviewer probe N4 teen: % assertions held', (select count(*) from p_result);
end
$verdict$;
rollback;
```

### PROBE (reviewer, round 3; the settle rule the app now follows): rv-n4-settle.sql

```sql
-- REVIEWER probe: the settle toggle a teen or child is offered on every share (expenses-module.tsx:251-264) vs expense_split_shares_update.
\set ON_ERROR_STOP on
begin;
create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    begin
      execute q;
      get diagnostics n = row_count;
      raise exception using errcode = 'SW001', message = n::text;
    exception
      when sqlstate 'SW001' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000f4000';
  uP uuid := '00000000-0000-4000-8000-0000000f4001';
  uT uuid := '00000000-0000-4000-8000-0000000f4003';
  uK uuid := '00000000-0000-4000-8000-0000000f4004';
  mP uuid; mT uuid; mK uuid;
  split uuid := '00000000-0000-4000-8000-0000000f40e1';
  split_t uuid := '00000000-0000-4000-8000-0000000f40e2';
  sP uuid; sT uuid; sTk uuid; sTt uuid;
  upd text := 'update public.expense_split_shares set settled = true, settled_at = now() where id = %L and family_id = %L';
begin
  insert into auth.users (id, email) values (uP, 'rv4-p@example.test'), (uT, 'rv4-t@example.test'), (uK, 'rv4-k@example.test');
  insert into public.families (id, name) values (fam, 'RV N4 settle');
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Ada', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.expense_splits (id, family_id, description, total_cents, paid_by, created_by) values
    (split, fam, 'Groceries', 4000, mP, uP), (split_t, fam, 'Pizza', 1200, mT, uT);
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split, mP, 2000) returning id into sP;
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split, mT, 2000) returning id into sT;
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split_t, mK, 600) returning id into sTk;
  insert into public.expense_split_shares (family_id, split_id, member_id, share_cents) values (fam, split_t, mT, 600) returning id into sTt;
  perform pg_temp.p_expect('teen settles the parent''s own share on the parent''s split (toggleSettled, expenses-module.tsx:171-173)', pg_temp.p_try(uT, format(upd, sP, fam)), '0');
  perform pg_temp.p_expect('control: teen settles their own share on the parent''s split', pg_temp.p_try(uT, format(upd, sT, fam)), 'ok');
  perform pg_temp.p_expect('child settles the teen''s own share on the teen''s split', pg_temp.p_try(uK, format(upd, sTt, fam)), '0');
  perform pg_temp.p_expect('control: teen (creator and payer) settles the child''s share on their split', pg_temp.p_try(uT, format(upd, sTk, fam)), 'ok');
  perform pg_temp.p_expect('control: parent settles any share', pg_temp.p_try(uP, format(upd, sTt, fam)), 'ok');
end
$probe$;
do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
  end loop;
  select count(*) into bad from p_result where not ok;
  raise notice 'reviewer verdict: % of % held', (select count(*) from p_result) - bad, (select count(*) from p_result);
end
$verdict$;
rollback;
```

## N1-residual (P2), OWNER DECISION

N1-residual (P2), OWNER DECISION. Unchanged from round 3; re-measured on #1 r4.

Who can do it:
- #1 keeps 0481 [FIX 1]. On 0001-0486 plus #1, any child, teen or caregiver may write a dose of a family-wide medicine (medications.member_id null) in their own name, on that medicine's own schedule, by INSERT or by UPDATE of their own dose.
- With the held supabase/reserved/0511 applied, only a caregiver can.

Measured:
- On copy C (#1 r4 twice, then the held 0511): probe-n1r-a had 2 of 19 FAIL. 'caregiver takes tomorrow's 08:00 slot in advance in their own name (0481 FIX 1)' got 1, and the parent's log of that slot then got error:23505 (uq_med_doses_slot). probe-n1r-b-r2 had 9 FAIL: the child's and the teen's writes got 'refused', and the caregiver's got 'unique'.
- On copy A (no 0511): probe-n1r-a had 10 of 19 FAIL.

The harm. uq_med_doses_slot (00261) is unique on (schedule_id, scheduled_for), so one member's row takes the slot for the whole household:
- the parent's buttons are disabled (medications-module.tsx:99, :484-486, :501, :504, :510);
- logDose refuses (:308-314);
- the module's insert (:325-329) would get 23505;
- the reminder reads the slot as logged (lib/server/notifications.ts:200, lib/notifications/medication-reminders.ts:64);
- the ring counts the member's 'skipped' (:278-281).

Reach: a direct PostgREST write only. The module never offers a non-manager a family-wide slot (:99, :262).

Ways out (apply one after #1): option (a) or option (b), next.

## N1-residual OPTION (a): a family-wide medicine's dose is a manager's to log

N1-residual OPTION (a): a family-wide medicine's dose is a manager's to log. It reverses 0481 [FIX 1]. The SQL is UNCHANGED.

What else it changes:
- 0481's comment 'a family-wide medication is dosed by whoever takes it' becomes untrue.
- probe-n1-n3's FIX 1 line must flip to want refused. After (a), it is that probe's only FAIL: 'caregiver logs the family-wide medicine on its own schedule in their own name (0481 FIX 1)' got refused.
- A non-manager's unscheduled dose of a family-wide medicine is also refused; the module offers none.
- No app change is needed: the module logs family-wide doses only as a manager, with member_id null (medications-module.tsx:325-329).

EXISTING ROWS. (a) refuses new rows only. Review the rows this read-only query lists; do not delete them wholesale:
select d.id, d.family_id, d.medication_id, d.schedule_id, d.scheduled_for, d.status, d.member_id, d.logged_by, d.created_at from public.medication_doses d join public.medications m on m.id = d.medication_id and m.family_id = d.family_id where m.member_id is null and d.member_id is not null and d.schedule_id is not null order by d.scheduled_for desc, d.id;
probe-n1r-inventory printed its OK line: the query also lists genuine history.

PROBE: probe-n1r-a (19, inline below).
- Copy A (#1-#4 applied): 10 FAIL before; 19 of 19 after (a) applied twice. After (a): probe-n1-n3 18 of 19 (the FIX 1 line), probe-oa1-repair-r4 20/20, rv-oa1-e-edges-r4 35/35.
- Copy C (#1 r4 plus the held 0511): 2 FAIL before (the caregiver pair); 19 of 19 after. The held reserved check printed OK, and so did prescription-write-boundary. Suite: 189/189.

### OPTION (a), full SQL (unchanged): option-a-r4.sql

```sql
-- N1-residual, owner option (a): a family-wide medicine's dose is the household's,
-- logged with member_id null by a manager, as medications-module.tsx logs it.
-- uq_med_doses_slot (00261) is on (schedule_id, scheduled_for) only, so under
-- 0481 [FIX 1] one child's, teen's or caregiver's dose of a family-wide medicine
-- took the slot for the whole family: the parent's log failed (23505, or the
-- module's doseChanged) and that day's reminder read the slot as logged.
-- This reverses 0481 [FIX 1]. Apply after owner action #1 (fix-n1-n3.sql).
do $$
declare
  arm text := '(public.can_manage_family(medication_doses.family_id) or exists (select 1 from public.medications m'
    || ' where m.id = medication_doses.medication_id and m.family_id = medication_doses.family_id'
    || ' and m.member_id is not null))';
begin
  if to_regclass('public.medication_doses') is null then return; end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception 'can_manage_family(uuid) is missing';
  end if;
  execute 'drop policy if exists medication_doses_family_wide_is_a_managers on public.medication_doses';
  execute 'create policy medication_doses_family_wide_is_a_managers on public.medication_doses as restrictive for insert to authenticated with check ' || arm;
  execute 'drop policy if exists medication_doses_family_wide_is_a_managers_update on public.medication_doses';
  execute 'create policy medication_doses_family_wide_is_a_managers_update on public.medication_doses as restrictive for update to authenticated using ' || arm || ' with check ' || arm;
end $$;
```

### PROBE: probe-n1r-a.sql

```sql
-- PROBE N1-residual, option (a): a family-wide medicine's scheduled slot is the
-- household's, logged with member_id null and only by a manager, so no child,
-- teen or caregiver can take it from the parent and silence that day's reminder.
-- Run after owner action #1 (fix-n1-n3.sql). Writes that land are KEPT inside
-- the probe's transaction (the household's log after a member's must see it);
-- everything is rolled back at the end.
\set ON_ERROR_STOP on
begin;

create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  perform set_config('request.jwt.claim.sub', who::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q;
    get diagnostics n = row_count;
    res := n::text;
  exception
    when insufficient_privilege then res := 'refused';
    when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;

-- what the reminder (lib/server/notifications.ts:200) and the module read on a slot
create function pg_temp.p_slot(sch uuid, at timestamptz) returns text language sql as $f$
  select coalesce(string_agg(case when d.member_id is null then 'household' else 'member' end || ' ' || d.status::text, ', ' order by d.id), 'none')
  from public.medication_doses d where d.schedule_id = sch and d.scheduled_for = at
$f$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000007a000';
  uP uuid := '00000000-0000-4000-8000-00000007a001';
  uA uuid := '00000000-0000-4000-8000-00000007a002';
  uT uuid := '00000000-0000-4000-8000-00000007a003';
  uK uuid := '00000000-0000-4000-8000-00000007a004';
  uC uuid := '00000000-0000-4000-8000-00000007a005';
  mP uuid; mA uuid; mT uuid; mK uuid; mC uuid;
  medF uuid; medK uuid; medC uuid;
  schF uuid; schF2 uuid; schK uuid; schC uuid;
  doseK uuid; doseK2 uuid; doseF uuid;
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
  eve timestamptz := date_trunc('day', now()) + interval '20 hours';
  ins text := 'insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n1r-parent@example.test'), (uA, 'n1r-adult@example.test'),
    (uT, 'n1r-teen@example.test'), (uK, 'n1r-child@example.test'), (uC, 'n1r-carer@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, timezone) values (fam, 'N1 residual (a)', 'UTC') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Parent', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'Adult', 'adult', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, null, 'Family vitamin', uP) returning id into medF;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mK, 'Kid syrup', uP) returning id into medK;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mC, 'Sitter allergy', uP) returning id into medC;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medF, '08:00') returning id into schF;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medF, '20:00') returning id into schF2;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medK, '08:00') returning id into schK;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medC, '08:00') returning id into schC;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, schK, mK, slot, 'taken', uK) returning id into doseK;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, schK, mK, slot - interval '1 day', 'taken', uK) returning id into doseK2;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medF, schF, null, slot - interval '3 days', 'taken', uP) returning id into doseF;

  -- The harm: a member's dose of the family-wide medicine takes the household's slot.
  perform pg_temp.p_expect('child takes today''s 08:00 family-vitamin slot in their own name (skipped)',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, mK, slot, 'skipped', uK)), 'refused');
  perform pg_temp.p_expect('parent then logs that slot as medications-module.tsx:325 sends it (member null)',
    pg_temp.p_try(uP, format(ins, fam, medF, schF, null, slot, 'taken', uP)), 'ok');
  perform pg_temp.p_expect('the 08:00 slot the reminder and the module read is the household''s',
    pg_temp.p_slot(schF, slot), 'household taken');
  perform pg_temp.p_expect('teen takes today''s 20:00 family-vitamin slot in their own name',
    pg_temp.p_try(uT, format(ins, fam, medF, schF2, mT, eve, 'skipped', uT)), 'refused');
  perform pg_temp.p_expect('adult then logs the 20:00 slot for the household',
    pg_temp.p_try(uA, format(ins, fam, medF, schF2, null, eve, 'taken', uA)), 'ok');
  perform pg_temp.p_expect('caregiver takes tomorrow''s 08:00 slot in advance in their own name (0481 FIX 1)',
    pg_temp.p_try(uC, format(ins, fam, medF, schF, mC, slot + interval '1 day', 'taken', uC)), 'refused');
  perform pg_temp.p_expect('parent then logs tomorrow''s 08:00 slot for the household',
    pg_temp.p_try(uP, format(ins, fam, medF, schF, null, slot + interval '1 day', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('child moves their own dose onto the family vitamin''s slot in two days (UPDATE)',
    pg_temp.p_try(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L, scheduled_for = %L where id = %L', medF, schF, slot + interval '2 days', doseK)), 'refused');
  perform pg_temp.p_expect('parent then logs that slot for the household',
    pg_temp.p_try(uP, format(ins, fam, medF, schF, null, slot + interval '2 days', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('option (a) also refuses a member''s UNSCHEDULED dose of a family-wide medicine (takes no slot; the module offers none)',
    pg_temp.p_try(uK, format(ins, fam, medF, null, mK, slot - interval '3 hours', 'taken', uK)), 'refused');

  -- Already held before (a): the household's row is a manager's.
  perform pg_temp.p_expect('child logs the household''s row (member null)',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, null, slot + interval '3 days', 'taken', uK)), 'refused');
  perform pg_temp.p_expect('caregiver logs the household''s row (member null)',
    pg_temp.p_try(uC, format(ins, fam, medF, schF, null, slot + interval '4 days', 'taken', uC)), 'refused');

  -- What still lands.
  perform pg_temp.p_expect('child logs their own medicine on its own schedule',
    pg_temp.p_try(uK, format(ins, fam, medK, schK, mK, slot - interval '2 days', 'taken', uK)), 'ok');
  perform pg_temp.p_expect('child marks their own dose skipped (status only, what the module sends)',
    pg_temp.p_try(uK, format('update public.medication_doses set status = ''skipped'', taken_at = null where id = %L', doseK2)), 'ok');
  perform pg_temp.p_expect('child deletes their own dose (the module''s toggle off)',
    pg_temp.p_try(uK, format('delete from public.medication_doses where id = %L', doseK2)), 'ok');
  perform pg_temp.p_expect('caregiver logs their own medicine',
    pg_temp.p_try(uC, format(ins, fam, medC, schC, mC, slot, 'taken', uC)), 'ok');
  perform pg_temp.p_expect('parent logs the child''s medicine',
    pg_temp.p_try(uP, format(ins, fam, medK, schK, mK, slot - interval '4 days', 'taken', uP)), 'ok');
  perform pg_temp.p_expect('parent corrects the household''s family-vitamin dose',
    pg_temp.p_try(uP, format('update public.medication_doses set status = ''skipped'', taken_at = null where id = %L', doseF)), 'ok');
  perform pg_temp.p_expect('parent logs an unscheduled family-vitamin dose',
    pg_temp.p_try(uP, format(ins, fam, medF, null, null, slot - interval '5 hours', 'taken', uP)), 'ok');
end
$probe$;

do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N1-residual (a): % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N1-residual (a): % assertions held', (select count(*) from p_result);
end
$verdict$;

rollback;
```

### PROBE (round 2, unchanged): probe-n1r-inventory.sql

```sql
-- PROBE N1-residual/note (2): what option (a)'s inventory query returns. It has
-- no date filter, so it lists rows from before 0481 as well, and it lists a
-- member's GENUINE doses of a medicine a parent later changed to 'Whole family'.
-- Read-only on a rolled-back fixture written through the members' own sessions.
\set ON_ERROR_STOP on
begin;
create function pg_temp.as_member(who uuid, q text) returns int language plpgsql as $f$
declare n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute q;
  get diagnostics n = row_count;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return n;
end $f$;
do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000009e000';
  uP uuid := '00000000-0000-4000-8000-00000009e001';
  uK uuid := '00000000-0000-4000-8000-00000009e004';
  mP uuid; mK uuid; medK uuid; schK uuid; n int; listed int;
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
begin
  insert into auth.users (id, email) values (uP, 'n1ri-p@example.test'), (uK, 'n1ri-k@example.test');
  insert into public.families (id, name, timezone) values (fam, 'N1r inventory', 'UTC');
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Parent', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mK, 'Kid vitamin', uP) returning id into medK;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medK, '08:00') returning id into schK;
  -- the child's genuine doses of their own medicine, today and yesterday
  n := pg_temp.as_member(uK, format('insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, ''taken'', %L), (%L, %L, %L, %L, %L, ''taken'', %L)',
    fam, medK, schK, mK, slot, uK, fam, medK, schK, mK, slot - interval '1 day', uK));
  -- a parent then makes it the whole family's (saveMed, the 'For' select's first option)
  n := pg_temp.as_member(uP, format('update public.medications set member_id = null where id = %L', medK));
  select count(*) into listed
    from public.medication_doses d join public.medications m on m.id = d.medication_id and m.family_id = d.family_id
   where m.member_id is null and d.member_id is not null and d.schedule_id is not null and d.family_id = fam;
  raise notice 'inventory lists % row(s) for the fixture: the child''s two genuine doses of a medicine since made the whole family''s', listed;
  if listed <> 2 then raise exception 'probe N1r inventory: expected the 2 genuine rows, got %', listed; end if;
  raise notice 'OK probe N1r inventory: the query lists genuine history, so its rows are reviewed, not deleted wholesale';
end
$probe$;
rollback;
```

## N1-residual OPTION (b): keep 0481 [FIX 1] and make each scheduled slot per member

N1-residual OPTION (b): keep 0481 [FIX 1] and make each scheduled slot per member. Apply part 1 and part 2 together, after #1. The SQL is UNCHANGED.

Part 2 is a SECURITY DEFINER BEFORE DELETE trigger on family_members. It covers G1 and G3 (a 'For' change after the slot was logged) and X (a member of two homes): the SET NULL it pre-empts is a referential action, which bypasses RLS.

REQUIRED APP CHANGES for (b). They are not made; the choice is the owner's.
1. lib/server/notifications.ts:200 must also read member_id. That file is in Codex's PR #1048.
   lib/notifications/medication-reminders.ts:64 must pass dosesForDay only the doses whose member_id is the medicine's. Otherwise lib/medications/adherence.ts:94-99 keeps the last row of the slot.
2. components/modules/medications-module.tsx:308-310: `existing` must also require x.member_id === med.member_id.
3. :278-281: count only doses whose member_id matches the medicine's, unless the owner decides otherwise.
4. todayDoses (:271-276) already reads the slot this way.
5. :484-486: targetUnavailable must ignore doses whose member_id differs from med.member_id, and keep the medication_id clause. Update tests/e2e/medications-ledger.spec.ts and tests/e2e/medications-readback-review.spec.ts to match.

NEW IN ROUND 4: (b) keys a slot by member, so the row #1 r4's (e) keeps (taken today under another member or the household) no longer holds the new member's slot.
- On copy B after (b): rv-oa1-e-edges-r4 gave 34 of 35. The child's (role authenticated) insert of today's 08:00 of the Vitamin D the manager logged 'taken' under member_id null, then gave to the child, got 1.
- On copy A, with (b) wrapped and rolled back: probe-oa1-repair-r4 gave 19 of 20. The teen's insert of today's 08:00 of the drops the child took got 1.
- If the owner picks (b), app change 5 should keep a slot disabled while a 'taken' row with the same schedule_id and scheduled_for exists for another member or the household. Otherwise the second log is accepted as (b)'s per-member meaning.

PROBE: probe-n1r-b-r2 (40, inline below), on copy B (#1 r4 and #3 applied; (d) and (e) matched 0 rows):
- before: 10 FAIL;
- part 1 only (applied twice): 10 FAIL;
- part 2 (applied twice): 40 of 40;
- probe-n1-n3: 19 of 19;
- suite: 189/189.

### OPTION (b) PART 1, full SQL (unchanged): option-b-index-r4.sql

```sql
-- N1-residual, owner option (b), part 1: keep 0481 [FIX 1] and make a scheduled
-- slot per member. The household's row (member_id null, the manager's log the
-- module sends) and each member's own row of a family-wide medicine are each
-- logged once; a prescribed medicine's slot stays one row, because its dose's
-- member is pinned to the medicine's (medication_doses_matches_med_guard).
-- The new index is built before the old one goes, so the slot is never unguarded.
create unique index if not exists uq_med_doses_member_slot
  on public.medication_doses (schedule_id, scheduled_for, member_id) nulls not distinct
  where schedule_id is not null;
drop index if exists public.uq_med_doses_slot;
```

### OPTION (b) PART 2, full SQL (unchanged): option-b-member-delete-r4.sql

```sql
-- N1-residual, owner option (b), part 2 (round 2). medication_doses.member_id
-- is ON DELETE SET NULL (00261). Under part 1's per-member index, a deleted
-- member's dose becomes a member-null row. If the slot already has the
-- household's row (member_id null), the delete fails with 23505: an erasure
-- (delete from auth.users) or a manager's delete of the member row.
--
-- Round 1 removed only a member's doses of a medicine that is family-wide
-- now. A manager can change a medicine's 'For' at any time (saveMed,
-- medications-module.tsx:657), so a member's genuine row can also become a
-- second member-null row:
-- - G1: the household logs the 08:00; the medicine is then given to the child,
--   who logs the same slot.
-- - G3: the child logs their inhaler; it is then given to the teen, who logs
--   the same slot.
--
-- So a deleted member's dose leaves with them in either of two cases:
-- - its medicine is not (now) prescribed to them, so once SET NULL it would
--   become a household row of a medicine that is not the household's;
-- - its slot already has the household's row, so once SET NULL it would
--   collide with that row.
-- A member's dose of their own prescribed medicine on a slot the household
-- has not logged is kept. medications.member_id is SET NULL in the same delete,
-- and that slot then holds one household row.
--
-- The trigger matches the member in any family, not only the member row's
-- own family. is_self_member is not tied to a family, so a member of two
-- households can write a dose in one household that names their member id in
-- the other. Erasing that person would otherwise collide in the first
-- household.
--
-- The function is SECURITY DEFINER because the SET NULL it pre-empts is a
-- referential action, which bypasses RLS. A manager's session deleting a member
-- row must clear every dose that SET NULL would collide on, including a dose
-- in another household that the manager cannot read. It is a trigger function,
-- so no client can call it.
create or replace function public.medication_doses_leave_with_their_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.medication_doses d
   using public.medications m
   where d.member_id = old.id
     and m.id = d.medication_id
     and m.family_id = d.family_id
     and (m.member_id is distinct from old.id
          or (d.schedule_id is not null and exists (
                select 1 from public.medication_doses o
                 where o.schedule_id = d.schedule_id
                   and o.scheduled_for = d.scheduled_for
                   and o.member_id is null)));
  return old;
end
$$;
revoke all on function public.medication_doses_leave_with_their_member() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.family_members') is null or to_regclass('public.medication_doses') is null then return; end if;
  execute 'drop trigger if exists trg_medication_doses_leave_with_their_member on public.family_members';
  execute 'create trigger trg_medication_doses_leave_with_their_member before delete on public.family_members for each row execute function public.medication_doses_leave_with_their_member()';
end $$;
```

### PROBE: probe-n1r-b-r2.sql

```sql
-- PROBE N1-residual, option (b): 0481 FIX 1 is kept and a scheduled slot is per
-- member: a member's own dose of a family-wide medicine no longer takes the
-- household's row (member_id null), each of them is still logged once, a
-- prescribed medicine's slot is still one row, and removing or erasing a member
-- who logged such a slot still works (member_id is ON DELETE SET NULL).
-- Run after owner action #1 (fix-n1-n3.sql). Writes that land are KEPT inside
-- the probe's transaction; everything is rolled back at the end.
\set ON_ERROR_STOP on
begin;

create function pg_temp.p_try(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  if who is not null then
    perform set_config('request.jwt.claim.sub', who::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin
    execute q;
    get diagnostics n = row_count;
    res := n::text;
  exception
    when insufficient_privilege then res := 'refused';
    when unique_violation then res := 'unique';
    when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  if who is not null then execute 'reset role'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

create function pg_temp.p_undo(who uuid, q text) returns text language plpgsql as $f$
declare n int; res text;
begin
  if who is not null then
    perform set_config('request.jwt.claim.sub', who::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin
    execute q;
    get diagnostics n = row_count;
    raise exception using errcode = 'SW001', message = n::text;
  exception
    when sqlstate 'SW001' then res := sqlerrm;
    when insufficient_privilege then res := 'refused';
    when unique_violation then res := 'unique';
    when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  if who is not null then execute 'reset role'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;
create temp table p_result (seq serial, label text, want text, got text, ok boolean) on commit drop;
create function pg_temp.p_expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  insert into p_result (label, want, got, ok) values (label, want, got,
    case want when 'refused' then got in ('refused', '0') when 'ok' then got ~ '^[1-9][0-9]*$' else got = want end);
end $f$;

create function pg_temp.p_household(sch uuid, at timestamptz) returns text language sql as $f$
  select coalesce(string_agg(d.status::text, ', ' order by d.id), 'none')
  from public.medication_doses d where d.schedule_id = sch and d.scheduled_for = at and d.member_id is null
$f$;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000007b000';
  uP uuid := '00000000-0000-4000-8000-00000007b001';
  uA uuid := '00000000-0000-4000-8000-00000007b002';
  uT uuid := '00000000-0000-4000-8000-00000007b003';
  uK uuid := '00000000-0000-4000-8000-00000007b004';
  uC uuid := '00000000-0000-4000-8000-00000007b005';
  mP uuid; mA uuid; mT uuid; mK uuid; mC uuid;
  medF uuid; medK uuid;
  schF uuid; schK uuid;
  doseK uuid; doseK2 uuid;
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
  ins text := 'insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (uP, 'n1rb-parent@example.test'), (uA, 'n1rb-adult@example.test'),
    (uT, 'n1rb-teen@example.test'), (uK, 'n1rb-child@example.test'), (uC, 'n1rb-carer@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, timezone) values (fam, 'N1 residual (b)', 'UTC') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uP, 'Parent', 'parent', true) returning id into mP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'Adult', 'adult', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uT, 'Teen', 'teen', true) returning id into mT;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uK, 'Kid', 'child', true) returning id into mK;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, null, 'Family vitamin', uP) returning id into medF;
  insert into public.medications (family_id, member_id, name, created_by) values (fam, mK, 'Kid syrup', uP) returning id into medK;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medF, '08:00') returning id into schF;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, medK, '08:00') returning id into schK;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, schK, mK, slot, 'taken', uK) returning id into doseK;
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, medK, schK, mK, slot - interval '1 day', 'taken', uK) returning id into doseK2;

  -- 0481 FIX 1 kept: a member logs a family-wide medicine in their own name.
  perform pg_temp.p_expect('child logs today''s 08:00 family vitamin in their own name (skipped)',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, mK, slot, 'skipped', uK)), 'ok');
  -- and the household's row is no longer blocked by it
  perform pg_temp.p_expect('parent then logs that slot as medications-module.tsx:325 sends it (member null)',
    pg_temp.p_try(uP, format(ins, fam, medF, schF, null, slot, 'taken', uP)), 'ok');
  perform pg_temp.p_expect('the household''s row on the 08:00 slot (member_id null) is the parent''s',
    pg_temp.p_household(schF, slot), 'taken');
  perform pg_temp.p_expect('teen logs the same slot in their own name',
    pg_temp.p_try(uT, format(ins, fam, medF, schF, mT, slot, 'taken', uT)), 'ok');
  perform pg_temp.p_expect('caregiver logs the same slot in their own name',
    pg_temp.p_try(uC, format(ins, fam, medF, schF, mC, slot, 'taken', uC)), 'ok');
  -- each of them is still one row
  perform pg_temp.p_expect('adult logs the household''s slot a second time',
    pg_temp.p_try(uA, format(ins, fam, medF, schF, null, slot, 'skipped', uA)), 'unique');
  perform pg_temp.p_expect('child logs their own row on the slot a second time',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, mK, slot, 'taken', uK)), 'unique');
  perform pg_temp.p_expect('a prescribed medicine''s slot is still one row (parent logs the child''s logged slot)',
    pg_temp.p_try(uP, format(ins, fam, medK, schK, mK, slot, 'taken', uP)), 'unique');
  -- the UPDATE path
  perform pg_temp.p_expect('child moves their own dose onto the family vitamin''s slot tomorrow (UPDATE)',
    pg_temp.p_try(uK, format('update public.medication_doses set medication_id = %L, schedule_id = %L, scheduled_for = %L where id = %L', medF, schF, slot + interval '1 day', doseK)), 'ok');
  perform pg_temp.p_expect('parent then logs tomorrow''s slot for the household',
    pg_temp.p_try(uP, format(ins, fam, medF, schF, null, slot + interval '1 day', 'taken', uP)), 'ok');
  -- the household's row is still a manager's
  perform pg_temp.p_expect('child logs the household''s row (member null)',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, null, slot + interval '2 days', 'taken', uK)), 'refused');

  -- member_id is ON DELETE SET NULL: deleting a member turns their row into a
  -- second member-null row on a slot the household also logged.
  perform pg_temp.p_expect('erasing the teen (auth user deleted; cascades to the member row) after both logged the slot',
    pg_temp.p_try(null, format('delete from auth.users where id = %L', uT)), 'ok');
  perform pg_temp.p_expect('deleting the caregiver''s member row after both logged the slot',
    pg_temp.p_try(null, format('delete from public.family_members where id = %L', mC)), 'ok');
  perform pg_temp.p_expect('the household''s row on the 08:00 slot is still only the parent''s after the removals',
    pg_temp.p_household(schF, slot), 'taken');
  perform pg_temp.p_expect('child logs the family vitamin''s slot in three days in their own name (the household has not)',
    pg_temp.p_try(uK, format(ins, fam, medF, schF, mK, slot + interval '3 days', 'skipped', uK)), 'ok');
  perform pg_temp.p_expect('erasing the child (auth user deleted)',
    pg_temp.p_try(null, format('delete from auth.users where id = %L', uK)), 'ok');
  perform pg_temp.p_expect('a removed member''s own dose does not become the household''s (slot in three days)',
    pg_temp.p_household(schF, slot + interval '3 days'), 'none');
  perform pg_temp.p_expect('the erased child''s dose of their own prescribed medicine is kept (member and medicine both SET NULL)',
    (select count(*)::text from public.medication_doses where id = doseK2 and member_id is null), '1');
  perform pg_temp.p_expect('deleting the whole family',
    pg_temp.p_try(null, format('delete from public.families where id = %L', fam)), 'ok');
end
$probe$;

-- Round 2 (N1-residual/b-trigger): a manager changes a medicine's 'For' (saveMed,
-- medications-module.tsx:657), and a member's genuine row would become a second
-- household row when that member is erased. Plus a member of two households.
do $gaps$
declare
  g1 uuid := '00000000-0000-4000-8000-00000007c000';
  g1P uuid := '00000000-0000-4000-8000-00000007c001';
  g1K uuid := '00000000-0000-4000-8000-00000007c004';
  g3 uuid := '00000000-0000-4000-8000-00000007d000';
  g3P uuid := '00000000-0000-4000-8000-00000007d001';
  g3T uuid := '00000000-0000-4000-8000-00000007d003';
  g3K uuid := '00000000-0000-4000-8000-00000007d004';
  xA uuid := '00000000-0000-4000-8000-00000007f000';
  xB uuid := '00000000-0000-4000-8000-00000007f100';
  xAP uuid := '00000000-0000-4000-8000-00000007f001';
  xBP uuid := '00000000-0000-4000-8000-00000007f101';
  xU uuid := '00000000-0000-4000-8000-00000007f0aa';
  m1P uuid; m1K uuid; m3P uuid; m3T uuid; m3K uuid; mAP uuid; mAU uuid; mBP uuid; mBU uuid;
  med1 uuid; sch1 uuid; med3 uuid; sch3 uuid; medA uuid; schA uuid;
  slot timestamptz := date_trunc('day', now()) + interval '8 hours';
  ins text := 'insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by) values (%L, %L, %L, %L, %L, %L, %L)';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values (g1P, 'n1rb-g1p@example.test'), (g1K, 'n1rb-g1k@example.test'),
    (g3P, 'n1rb-g3p@example.test'), (g3T, 'n1rb-g3t@example.test'), (g3K, 'n1rb-g3k@example.test'),
    (xAP, 'n1rb-xap@example.test'), (xBP, 'n1rb-xbp@example.test'), (xU, 'n1rb-xu@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, timezone) values (g1, 'N1r(b) G1', 'UTC'), (g3, 'N1r(b) G3', 'UTC'), (xA, 'N1r(b) X home', 'UTC'), (xB, 'N1r(b) X other home', 'UTC') on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (g1, g1P, 'Parent', 'parent', true) returning id into m1P;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (g1, g1K, 'Kid', 'child', true) returning id into m1K;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (g3, g3P, 'Parent', 'parent', true) returning id into m3P;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (g3, g3T, 'Teen', 'teen', true) returning id into m3T;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (g3, g3K, 'Kid', 'child', true) returning id into m3K;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (xA, xAP, 'Parent', 'parent', true) returning id into mAP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (xA, xU, 'Stepkid', 'child', true) returning id into mAU;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (xB, xBP, 'Parent', 'parent', true) returning id into mBP;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (xB, xU, 'Stepkid', 'child', true) returning id into mBU;
  insert into public.medications (family_id, member_id, name, created_by) values (g1, null, 'Vitamin D', g1P) returning id into med1;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (g1, med1, '08:00') returning id into sch1;
  insert into public.medications (family_id, member_id, name, created_by) values (g3, m3K, 'Inhaler', g3P) returning id into med3;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (g3, med3, '08:00') returning id into sch3;
  insert into public.medications (family_id, member_id, name, created_by) values (xA, null, 'Fluoride', xAP) returning id into medA;
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (xA, medA, '08:00') returning id into schA;

  -- G1, all in the app: the household's 08:00 is logged, the medicine is given to the child, the child's 08:00 is logged.
  perform pg_temp.p_expect('G1 parent logs the family-wide 08:00 for the household', pg_temp.p_try(g1P, format(ins, g1, med1, sch1, null, slot, 'taken', g1P)), 'ok');
  perform pg_temp.p_expect('G1 parent gives the medicine to the child (saveMed)', pg_temp.p_try(g1P, format('update public.medications set member_id = %L where id = %L', m1K, med1)), 'ok');
  perform pg_temp.p_expect('G1 parent logs the child''s 08:00 (member = the medicine''s)', pg_temp.p_try(g1P, format(ins, g1, med1, sch1, m1K, slot, 'taken', g1P)), 'ok');
  perform pg_temp.p_expect('G1 erasing the child (auth user deleted)', pg_temp.p_undo(null, format('delete from auth.users where id = %L', g1K)), '1');
  perform pg_temp.p_expect('G1 the parent deletes the child''s member row (fm_delete, the parent''s session)', pg_temp.p_undo(g1P, format('delete from public.family_members where id = %L', m1K)), '1');
  perform pg_temp.p_expect('G1 deleting the whole family', pg_temp.p_undo(null, format('delete from public.families where id = %L', g1)), '1');
  perform pg_temp.p_expect('G1 erasing the child, for real', pg_temp.p_try(null, format('delete from auth.users where id = %L', g1K)), 'ok');
  perform pg_temp.p_expect('G1 the 08:00 still has exactly the household''s one row', pg_temp.p_household(sch1, slot), 'taken');

  -- G3, all in the app: the child logs their inhaler, it is given to the teen, the teen logs the same slot.
  perform pg_temp.p_expect('G3 child logs their own 08:00 inhaler', pg_temp.p_try(g3K, format(ins, g3, med3, sch3, m3K, slot, 'taken', g3K)), 'ok');
  perform pg_temp.p_expect('G3 parent gives the inhaler to the teen', pg_temp.p_try(g3P, format('update public.medications set member_id = %L where id = %L', m3T, med3)), 'ok');
  perform pg_temp.p_expect('G3 teen logs their own 08:00', pg_temp.p_try(g3T, format(ins, g3, med3, sch3, m3T, slot, 'taken', g3T)), 'ok');
  perform pg_temp.p_expect('G3 erasing the teen first', pg_temp.p_undo(null, format('delete from auth.users where id = %L', g3T)), '1');
  perform pg_temp.p_expect('G3 erasing the child', pg_temp.p_try(null, format('delete from auth.users where id = %L', g3K)), 'ok');
  perform pg_temp.p_expect('G3 then erasing the teen', pg_temp.p_try(null, format('delete from auth.users where id = %L', g3T)), 'ok');
  perform pg_temp.p_expect('G3 the 08:00 holds one household row (the teen''s, SET NULL with the medicine)', pg_temp.p_household(sch3, slot), 'taken');
  perform pg_temp.p_expect('G3 deleting the whole family', pg_temp.p_try(null, format('delete from public.families where id = %L', g3)), 'ok');

  -- X: a child of two households (is_self_member is not tied to a family) logs home A's family-wide
  -- medicine under their member id in home B, by a direct write; home A's parent logs the household's row.
  perform pg_temp.p_expect('X the child of two homes logs home A''s 08:00 under their home-B member id', pg_temp.p_try(xU, format(ins, xA, medA, schA, mBU, slot, 'taken', xU)), 'ok');
  perform pg_temp.p_expect('X home A''s parent logs the household''s 08:00', pg_temp.p_try(xAP, format(ins, xA, medA, schA, null, slot, 'taken', xAP)), 'ok');
  perform pg_temp.p_expect('X home B''s parent deletes the child''s home-B member row (cannot read home A''s doses)', pg_temp.p_undo(xBP, format('delete from public.family_members where id = %L', mBU)), '1');
  perform pg_temp.p_expect('X erasing the child of two homes (auth user deleted)', pg_temp.p_try(null, format('delete from auth.users where id = %L', xU)), 'ok');
  perform pg_temp.p_expect('X home A''s 08:00 still has exactly the household''s one row', pg_temp.p_household(schA, slot), 'taken');
end
$gaps$;

do $verdict$
declare r record; bad int; lines text := '';
begin
  for r in select * from p_result order by seq loop
    raise notice '% [want %, got %] %', case when r.ok then 'ok  ' else 'FAIL' end, r.want, r.got, r.label;
    if not r.ok then lines := lines || E'\n  - ' || r.label || ' (got ' || r.got || ')'; end if;
  end loop;
  select count(*) into bad from p_result where not ok;
  if bad > 0 then raise exception 'probe N1-residual (b): % assertion(s) failed:%', bad, lines; end if;
  raise notice 'OK probe N1-residual (b): % assertions held', (select count(*) from p_result);
end
$verdict$;

rollback;
```

## OBSERVATIONS (no change made):

OBSERVATIONS (no change made):
- (a) Round 3's settle-toggle observation is closed by this commit (N4-sibling/settle).
- (b) A claimer of a gift they bought still gets 'Claim gift'. claimState reads is_purchased first (lib/wishlists/gifts.ts:27-29), and the button is at components/modules/wishlists-module.tsx:226-229. Clicking it un-buys the gift (:121). It is the claimer's own undo, and #3 r4 keeps it.
- (c) A dose (e) keeps as taken today shows on a manager's screen as a slot marked 'This dose changed', with its buttons disabled; the medicine's own non-manager member does not read the row, so on their screen the slot reads pending with its buttons enabled and every tap is refused with 23505 and the 'This dose changed' toast. todayDoses (medications-module.tsx:271-276) drops it, while targetUnavailable (:484-486) still sees it. The reminder treats the slot as logged. Not needed for the repair, so not changed.
- (d) I edited no file on PR #1048's list, nothing under supabase/, and no docs/audit/*-check.sql.

