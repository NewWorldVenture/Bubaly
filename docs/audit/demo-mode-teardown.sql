-- Bubaly :: demo mode teardown — OPERATOR SCRIPT, NOT A MIGRATION
-- ============================================================================
-- Removes what demo mode left in the database after its code was deleted:
-- two bookkeeping tables and one seeded household.
--
-- WHY THIS IS NOT A MIGRATION. tests/migrations-are-additive.test.ts holds the
-- whole migration history to zero DROP TABLE / DROP COLUMN / TRUNCATE / DROP
-- TYPE statements, and says why: an agent authors migrations, a human applies
-- the pending set later with `supabase db push`, and a destructive statement
-- sitting in that set destroys production data the moment they do. This
-- teardown is destructive twice over — it drops two tables AND deletes a
-- families row that cascades into all 174 family-scoped tables — so it is
-- deliberately kept OUT of the migration path and run by hand, the same way
-- 0275 was (docs/runbooks/LB-016 §5). Nothing applies it for you.
--
-- Named *-teardown.sql, not *-check.sql, so docs/audit/run-probes.sh does not
-- glob it into CI: it asserts an end state but it is not a probe, and a probe
-- that mutates has no business running on every pull request.
--
-- NOTHING IS BROKEN IF YOU NEVER RUN THIS. With the code gone the two tables
-- take writes from nobody and the demo family is unreachable — no route, no
-- login, no cron. This reclaims the space and removes the data; it does not
-- unblock anything.
--
-- BEFORE YOU RUN IT
--   * Step 1 is read-only. Run it first and read what comes back.
--   * Step 2 is a prerequisite on any database below migration 0249. Skipping
--     it makes step 3b fail outright — see the error quoted there.
--   * The family delete (3b) is irreversible and cascades. Take a backup.
--   * Confirm no real household is named 'Bubaly Demo Account' or 'Bubaly
--     Demo'. The match is on the exact name; a family that merely contains the
--     word "demo" is NOT matched, and must not be.
--
-- Every step is idempotent and safe to re-run, and step 4 reports the end
-- state. Run the steps as SEPARATE statements, not as one block — the reason
-- is in the note above step 3.

-- ── Step 1 — look before you delete (read-only, changes nothing) ────────────
select 'demo_sessions'   as object,
       to_regclass('public.demo_sessions')::text          as exists_as,
       (select count(*) from public.demo_sessions)        as rows
where  to_regclass('public.demo_sessions') is not null
union all
select 'demo_email_uses',
       to_regclass('public.demo_email_uses')::text,
       (select count(*) from public.demo_email_uses)
where  to_regclass('public.demo_email_uses') is not null
union all
select 'demo family: ' || f.name, f.id::text, null
from   public.families f
where  f.name in ('Bubaly Demo Account', 'Bubaly Demo');

-- ── Step 2 — PREREQUISITE: make the family delete survivable ───────────────
-- Run this BEFORE step 3, on any database whose migration ledger has not
-- reached 0249. Skipping it produces exactly this, seen on production:
--
--   ERROR: 23503: insert or update on table "family_model_dirty" violates
--   foreign key constraint "family_model_dirty_family_id_fkey"
--   CONTEXT: PL/pgSQL function mark_model_dirty() line 7
--            SQL statement "delete from public.families where name = any (...)"
--
-- Why: 0134 attached trg_mark_model_dirty (AFTER INSERT/UPDATE/DELETE) to ten
-- family-scoped tables. Deleting a family cascades into them, each cascaded
-- DELETE fires the trigger with old.family_id, and the trigger's INSERT into
-- family_model_dirty references a families row that no longer exists. Every
-- family-deletion path hits this once the family has a single member.
--
-- This is the body of supabase/migrations/0249_model_dirty_delete_safe.sql,
-- verbatim. It replaces one function: additive, idempotent, reads and writes
-- no data. Applying it by hand is the same trade §5 of LB-016 describes for
-- 0254 and 0275 — it widens the ledger gap by one more unrecorded migration.

create or replace function public.mark_model_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid;
begin
  v_family := coalesce((case when tg_op = 'DELETE' then old.family_id else new.family_id end), null);
  if v_family is null then
    return null;
  end if;
  -- The family is mid-delete (cascade) or already gone: nothing to mark.
  if not exists (select 1 from public.families f where f.id = v_family) then
    return null;
  end if;
  begin
    insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
    values (v_family, true, tg_table_name, now())
    on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();
  exception when foreign_key_violation then
    -- Deleted between the existence check and the insert; same answer.
    return null;
  end;
  return null; -- AFTER trigger, result ignored
end $$;

-- ── Step 3 — remove it, one statement at a time ────────────────────────────
-- DELIBERATELY NOT one do-block. The first version of this script wrapped
-- everything in a single do $$ … $$, which Postgres runs as ONE transaction:
-- when the dashboard dropped the connection ("Connection terminated due to
-- connection timeout") the whole thing rolled back, including the two cheap
-- table drops. Run these as separate statements so the fast work survives a
-- timeout on the slow work, and so you can see which step you are on.

-- 3a — the bookkeeping tables. Instant. 0138 added demo_sessions (with its
-- expiry index and the demo_sessions_select_own policy), 0161 made expires_at
-- nullable and added a created_at index, 0162 added demo_email_uses. Dropping
-- each table takes its own indexes and policies with it.
-- demo_email_uses first: its only reader was the CRM lead score ("Tried the
-- demo", +18), which no longer exists.
drop table if exists public.demo_email_uses;
drop table if exists public.demo_sessions;

-- 3b — the seeded demo household. THIS IS THE SLOW ONE, and the only
-- destructive step: a REAL families row carrying members, chores, events,
-- wallets and the rest. Every table referencing public.families(id) declares
-- ON DELETE CASCADE and none uses RESTRICT, so this one statement removes its
-- data rather than leaving orphans — which is also why it can take minutes.
--
-- IF THIS TIMES OUT IN THE DASHBOARD: the SQL editor gives up long before
-- Postgres does. Run the same statement over a direct connection instead
-- (Project Settings → Database → Connection string → psql), where nothing
-- caps it. Re-running is safe: it is scoped by exact name and matches nothing
-- once the family is gone.
delete from public.families where name in ('Bubaly Demo Account', 'Bubaly Demo');

-- 3c — the shared demo login. Needs a privileged role; if it errors with
-- insufficient privilege, delete demo@demo.bubaly.app from the Supabase
-- dashboard instead. An auth user with no family is inert either way.
delete from auth.users where email = 'demo@demo.bubaly.app';

-- ── Step 4 — confirm the end state (read-only) ─────────────────────────────
-- Expect zero rows. Any row returned names something still present.
select 'demo_sessions still exists'   as leftover where to_regclass('public.demo_sessions')   is not null
union all
select 'demo_email_uses still exists'                where to_regclass('public.demo_email_uses') is not null
union all
select 'demo family still present: ' || f.name from public.families f
where  f.name in ('Bubaly Demo Account', 'Bubaly Demo')
union all
select 'demo auth user still present' from auth.users where email = 'demo@demo.bubaly.app';
