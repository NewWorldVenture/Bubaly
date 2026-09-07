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
--   * The family delete is irreversible and cascades. Take a backup.
--   * Confirm no real household is named 'Bubaly Demo Account' or 'Bubaly
--     Demo'. The match is on the exact name; a family that merely contains the
--     word "demo" is NOT matched, and must not be.
--
-- Idempotent: safe to re-run. Asserts its end state and raises rather than
-- reporting success if anything survives.

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

-- ── Step 2 — remove it ─────────────────────────────────────────────────────
-- Run everything below as one statement.

do $$
declare
  demo_family_names constant text[] := array['Bubaly Demo Account', 'Bubaly Demo'];
  demo_email        constant text   := 'demo@demo.bubaly.app';
  families_removed  integer := 0;
  users_removed     integer := 0;
  leftover          integer;
begin
  -- The bookkeeping tables. 0138 added demo_sessions (+ its expiry index and
  -- the demo_sessions_select_own policy), 0161 made expires_at nullable and
  -- added a created_at index, 0162 added demo_email_uses. Dropping each table
  -- takes its own indexes and policies with it, so none of those need naming.
  --
  -- demo_email_uses first: its only reader was the CRM lead score ("Tried the
  -- demo", +18), which no longer exists.
  drop table if exists public.demo_email_uses;
  drop table if exists public.demo_sessions;

  -- The seeded demo household — a REAL families row carrying members, chores,
  -- events, wallets and the rest. Every table referencing public.families(id)
  -- declares ON DELETE CASCADE and none uses RESTRICT or NO ACTION, so this
  -- one statement removes its data rather than leaving orphans.
  delete from public.families where name = any (demo_family_names);
  get diagnostics families_removed = row_count;

  -- The shared demo login. Guarded: on a database where this runs as a role
  -- without rights on auth.users, skip with a notice rather than abort — the
  -- household above is what matters, and an auth user with no family is inert.
  begin
    delete from auth.users where email = demo_email;
    get diagnostics users_removed = row_count;
  exception
    when insufficient_privilege or undefined_table then
      raise notice 'demo teardown: could not remove the demo auth user (%) — insufficient privilege. Delete it from the Supabase dashboard.', demo_email;
  end;

  -- Assert the end state rather than trusting the statements above.
  if to_regclass('public.demo_sessions') is not null then
    raise exception 'demo teardown FAILED: public.demo_sessions still exists';
  end if;
  if to_regclass('public.demo_email_uses') is not null then
    raise exception 'demo teardown FAILED: public.demo_email_uses still exists';
  end if;

  select count(*) into leftover from public.families where name = any (demo_family_names);
  if leftover <> 0 then
    raise exception 'demo teardown FAILED: % demo family row(s) still present', leftover;
  end if;

  raise notice 'demo teardown OK: dropped demo_sessions and demo_email_uses; removed % demo family row(s) and % demo auth user(s)',
    families_removed, users_removed;
end $$;
