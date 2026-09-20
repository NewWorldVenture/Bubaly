-- Bubaly :: 0340 an erasure actually erases
-- ----------------------------------------------------------------------------
-- AUTHZ-023. `public.attribution_is_immutable()` (0338:110-121) preserves the
-- attribution columns UNCONDITIONALLY:
--
--     new.logged_by := old.logged_by;
--     if to_jsonb(new) ? 'created_by' then new.created_by := old.created_by; end if;
--
-- That is correct for an application UPDATE and WRONG for a referential action.
-- Five attribution columns across the four tables 0338 attaches it to are
-- `ON DELETE SET NULL` -- read from pg_constraint (confdeltype = 'n') with the
-- REFERENCED table included, because the first version of that query omitted it
-- and misread care_log.logged_by as pointing at auth.users:
--
--     behavior_logs.logged_by        -> auth.users       SET NULL
--     care_log.created_by            -> auth.users       SET NULL
--     care_log.logged_by             -> family_members   SET NULL
--     medication_doses.logged_by     -> auth.users       SET NULL
--     screen_time_entries.logged_by  -> auth.users       SET NULL
--
-- Postgres performs `ON DELETE SET NULL` as an ordinary UPDATE against the
-- referencing row, so a BEFORE UPDATE trigger sees it and can overwrite it.
-- This one does: it puts the deleted id straight back.
--
-- ── THE TWO SYMPTOMS, AND WHICH ONE PRODUCTION GETS ──────────────────────────
--
-- MEASURED, holding the schema, the constraint and the trigger fixed and
-- varying nothing but the transaction mode:
--
--   autocommit            created_by keeps naming the deleted user and NO error
--                         is raised -- a dangling reference is COMMITTED.
--   inside a transaction  RI_FKey_check_upd fires and the DELETE is refused with
--                         "violates foreign key constraint".
--
-- The production symptom is the SILENT one. `admin.auth.admin.deleteUser` issues
-- a single DELETE in its own transaction, so a real erasure takes the autocommit
-- row: the account goes, the attribution stays, and nothing reports it. The
-- visible foreign key error is what a PROBE sees, because every probe in this
-- audit runs inside a transaction it rolls back. Recording only the error would
-- have described the instrument rather than the defect.
--
-- So this is data outliving a deletion request, not an operation that fails
-- loudly and gets retried.
--
-- ── SCOPE, STATED HONESTLY ───────────────────────────────────────────────────
--
-- 0338 is UNAPPLIED in production (docs/PENDING_PROD_MIGRATIONS.md), so this is
-- being fixed before it ships rather than after. No shipped product path reaches
-- it today either: the only three `admin.auth.admin.deleteUser` call sites are
-- rollbacks in app/(app)/family/child-login-actions.ts:62,:69,:79, each on a
-- child auth user created a few lines above that cannot yet have authored a row.
-- Family erasure is unaffected -- `delete from families` reaches these tables
-- through `family_id` CASCADE, so the rows are gone before the column matters.
--
-- What IS exposed: deleting an auth user from the Supabase dashboard or the
-- admin API, and any future account-deletion or GDPR-erasure feature, which
-- would fail on its first real user -- silently, leaving the name of the deleted
-- person attached to rows a `care-module.tsx:253`-style renderer still draws.
--
-- ── THE GUARD ────────────────────────────────────────────────────────────────
--
-- `pg_trigger_depth() = 1` is an application UPDATE; the FK's referential action
-- fires this trigger at depth 2. MEASURED both ways. Guarding the preserve on
-- depth 1 keeps every freeze 0338 shipped (its own probe still passes) while
-- letting the constraint do the job it declares.
--
-- Is `= 1` itself a hole? Only a TRIGGER-ISSUED update reaches depth 2, so the
-- question is whether one exists. Asked of the catalog rather than by grepping:
-- no trigger function attached to any table, and no function in any non-system
-- schema, contains an UPDATE against these four tables. A function invoked
-- directly is not a path either -- its UPDATE still runs triggers at depth 1.
-- The assertion block below RE-ASKS that at every replay, so the day someone
-- adds such a trigger this migration fails rather than silently stops guarding.
-- That is the one thing a future edit is most likely to get wrong, and it is the
-- mirror of the defect being fixed here.
--
-- ── AUTHZ-022, the same function's other complaint ───────────────────────────
--
-- `new.logged_by` is assigned unconditionally while `created_by` gets a presence
-- test, so the function raises `record "new" has no field "logged_by"` (42703)
-- on any table without that column -- while its own `comment on function`
-- describes it as shared and general. 0339 worked around this by creating a
-- DEDICATED function rather than widening this one. The claim of generality is
-- still false, so it is made true here: `logged_by` gets the same presence test
-- `created_by` already has. This changes NOTHING on the four tables 0338
-- attaches it to, because all four carry both columns -- it is the comment that
-- was wrong, and a function whose comment lies is how AUTHZ-022 happened.
--
-- Both repairs are one line each on the same function. They are in one migration
-- because splitting them would mean two migrations replacing the same function
-- in sequence, which is churn rather than clarity.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

create or replace function public.attribution_is_immutable()
returns trigger language plpgsql as $fn$
begin
  -- Preserve rather than refuse: the app never sends these columns on UPDATE, so
  -- a check would fail the legitimate edit of somebody else's entry while a
  -- preserve simply keeps the truth that was recorded.
  --
  -- DEPTH 1 ONLY. Depth 2 is a referential action -- the ON DELETE SET NULL that
  -- four of these five columns declare -- and reverting it leaves a dangling
  -- reference committed with no error (measured; see the header). Removing this
  -- condition re-opens AUTHZ-023.
  if pg_trigger_depth() = 1 then
    -- BOTH columns get the presence test. 0338 gave one to `created_by` and
    -- not to `logged_by`, which is AUTHZ-022: the function aborts every UPDATE
    -- on a table lacking `logged_by` while its comment calls itself general.
    if to_jsonb(new) ? 'logged_by' then
      new.logged_by := old.logged_by;
    end if;
    if to_jsonb(new) ? 'created_by' then
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end $fn$;

comment on function public.attribution_is_immutable() is
  '0338, repaired by 0340 (AUTHZ-023/AUTHZ-022): logged_by/created_by are fixed at insert against APPLICATION updates (pg_trigger_depth 1) while the columns'' own ON DELETE SET NULL referential actions (depth 2) still fire, so erasing an account actually clears the attribution. Each column is preserved only if the row carries it, so the function is safe on any table rather than only on one carrying both.';

do $$
declare
  fn_def    text;
  t         text;
  offenders text;
begin
  fn_def := pg_get_functiondef('public.attribution_is_immutable()'::regprocedure);

  -- THE ONE A FUTURE EDIT IS MOST LIKELY TO UNDO.
  if fn_def not like '%pg_trigger_depth()%' then
    raise exception '0340: attribution_is_immutable() lost its pg_trigger_depth guard — ON DELETE SET NULL would be reverted and an account erasure would silently leave dangling references';
  end if;
  -- BOTH presence tests are asserted. The first draft of this migration added
  -- the guard, wrote a comment claiming both columns were tested, and left
  -- `logged_by` unconditional -- shipping the very defect AUTHZ-022 names, with
  -- a comment that now affirmatively stated a test that did not exist. Two
  -- independent reviewers caught it. Asserting each one by name is what makes
  -- the comment answerable to the code.
  if fn_def not like '%to_jsonb(new) ? ''created_by''%' then
    raise exception '0340: attribution_is_immutable() lost the created_by presence test';
  end if;
  if fn_def not like '%to_jsonb(new) ? ''logged_by''%' then
    raise exception '0340: attribution_is_immutable() has no logged_by presence test — AUTHZ-022 is open and the function''s comment claims otherwise';
  end if;

  -- 0338's tables must still carry the trigger; this migration repairs the
  -- function and must not be read as having re-attached anything.
  foreach t in array array['care_log','behavior_logs','screen_time_entries','medication_doses'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not exists (
      select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
       where tg.tgrelid = ('public.' || t)::regclass
         and not tg.tgisinternal
         and p.proname = 'attribution_is_immutable'
    ) then
      raise exception '0340: % no longer carries 0338''s attribution trigger', t;
    end if;
  end loop;

  -- The depth test is exact only while nothing issues a nested UPDATE against
  -- these tables. Re-asked at every replay rather than trusted from the day it
  -- was measured: a trigger added later would make the freeze stop guarding
  -- rows updated through it, silently and in the attacker's favour.
  -- p.prosrc, NOT pg_get_functiondef(p.oid). This read is a plain COLUMN and
  -- cannot raise; pg_get_functiondef() throws '"array_agg" is an aggregate
  -- function' when handed an aggregate's oid. The join to pg_trigger means no
  -- aggregate SHOULD reach it — but a filter on a joined relation is not
  -- ordered, and the planner is free to evaluate it while scanning pg_proc,
  -- before the join has excluded anything. That is exactly what happened: this
  -- query passed locally on a nested loop driven by pg_trigger and FAILED in CI
  -- on a plan that scanned pg_proc first. The first version was only
  -- accidentally safe, and a guard whose correctness depends on a query plan is
  -- not a guard.
  select string_agg(distinct p.proname || ' on ' || tg.tgrelid::regclass::text, ', ')
    into offenders
    from pg_trigger tg
    join pg_proc p on p.oid = tg.tgfoid
   where not tg.tgisinternal
     and p.prokind = 'f'
     and p.prosrc ~* 'update\s+(public\.)?(care_log|behavior_logs|screen_time_entries|medication_doses)\M';
  if offenders is not null then
    raise exception '0340: a trigger now issues a nested UPDATE against a table the attribution freeze guards (%), so pg_trigger_depth() = 1 no longer covers every application write — re-derive the guard rather than widening it', offenders;
  end if;

  raise notice '0340 OK: the attribution freeze still refuses an application rewrite, and an account erasure now actually clears the columns that declare ON DELETE SET NULL instead of silently committing a dangling reference.';
end $$;
