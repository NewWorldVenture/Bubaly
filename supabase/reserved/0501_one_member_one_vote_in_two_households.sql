-- 0501 — One person, one vote, for a member of two families.
-- 0311's family-scoped references, on the four tables where a second member id
-- is a second vote. Found and reproduced 2026-10-10 on a replay of every
-- runnable migration.
--
-- Twenty-three tables let a member write as themselves with
-- `is_family_member(family_id) and is_self_member(member_id)`. is_self_member
-- asks whether the member row is the caller's, in ANY family, so a person active
-- in two families (a child of two households, a grandparent of two) can file a
-- row in family A under their member id from family B. The owner's review of
-- 0500 (6095082508) named the pattern on reward requests. Where it matters is
-- counting: each of these tables is unique per (option, member), and every
-- tally reads the votes of its own family, so the second member id is a second
-- voter. Measured as such a child, in one household, under PostgREST's role:
--
--   family_poll_votes   a second vote for the same option   landed (2 votes)
--   meal_vote_ballots   a second ballot on the same dish    landed
--   watchlist_votes     a second vote on the same title     landed
--   event_rsvps         a second RSVP to the same event     landed
--
-- This wires 0311's own reference_shares_family('member_id', 'family_members')
-- onto those four, exactly as 0497 wires it: BEFORE INSERT OR UPDATE OF
-- member_id, family_id, after checking each table and its parent carry
-- family_id (0311's warning: a parent without it raises 42703 on every write).
-- No new function. The service role and session-less writers stay exempt. The
-- in-app writers (voting-module, the meal vote and watchlist modules, the RSVP
-- control) always use the active family's own member, so nothing legitimate
-- changes, and a member of two families still votes once in each.
--
-- Not changed, recorded: sixteen more tables use the same unbound
-- is_self_member, where the second member id files the person's own data
-- (health, sleep, journal, location, a dispute, a report) under their other
-- membership and nothing is counted twice: announcement_reads, chore_disputes,
-- chore_submissions (a payout follows chore_assignments, which 0311 binds),
-- driver_licenses, family_facts, health_goals, health_metrics, journal_entries,
-- location_events, marketplace_reports, member_locations, nutrition_logs,
-- safety_check_ins, sleep_checkins, sleep_logs, symptom_logs. Each is one more
-- line of this loop if the owner wants it.
--
-- HELD: proposed as 0501 (the first number above 0500; requested on #771 in
-- comment 6095180270, not yet confirmed) in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/one-member-one-vote-in-two-households-check.sql and
-- .github/workflows/one-member-one-vote-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  w record;
begin
  if to_regprocedure('public.reference_shares_family()') is null then
    raise exception '0501 needs reference_shares_family() from 0311';
  end if;
  for w in
    select *
    from (values
      ('family_poll_votes', 'member_id', 'family_members'),
      ('meal_vote_ballots', 'member_id', 'family_members'),
      ('watchlist_votes',   'member_id', 'family_members'),
      ('event_rsvps',       'member_id', 'family_members')
    ) as v(child, col, parent)
  loop
    if to_regclass('public.' || w.child) is null or to_regclass('public.' || w.parent) is null then
      raise exception '0501: public.% or public.% does not exist', w.child, w.parent;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = 'family_id') then
      raise exception '0501: %.family_id does not exist', w.child;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = w.col) then
      raise exception '0501: %.% does not exist', w.child, w.col;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.parent and column_name = 'family_id') then
      raise exception
        '0501: parent %.family_id does not exist, so the guard on %.% would raise 42703 on every authenticated write',
        w.parent, w.child, w.col;
    end if;
    execute format('drop trigger if exists %I on public.%I',
                   'trg_' || w.child || '_' || w.col || '_family', w.child);
    execute format(
      'create trigger %I before insert or update of %I, family_id on public.%I '
      || 'for each row execute function public.reference_shares_family(%L, %L)',
      'trg_' || w.child || '_' || w.col || '_family', w.col, w.child, w.col, w.parent);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger t
   where t.tgfoid = 'public.reference_shares_family()'::regprocedure
     and t.tgenabled <> 'D'
     and (t.tgtype & 2) = 2
     and (t.tgrelid, encode(t.tgargs, 'escape')) in (
       ('public.family_poll_votes'::regclass, E'member_id\\000family_members\\000'),
       ('public.meal_vote_ballots'::regclass, E'member_id\\000family_members\\000'),
       ('public.watchlist_votes'::regclass,   E'member_id\\000family_members\\000'),
       ('public.event_rsvps'::regclass,       E'member_id\\000family_members\\000'));
  if n <> 4 then
    raise exception '0501: % of 4 vote tables are wired to reference_shares_family', n;
  end if;
end
$$;
