-- 0531 — The household's document, renewal and Autopilot insights are a
-- parent's or another adult's to read.
-- Requested on #771 in comment 6560944423, before any SQL: OPSD-O08
-- (N9-S2-AT-REST), with the reviewer's corrected policy, OPSD-O09.
--
-- daily_insights (0141) keeps one row per family, day and kind, and 0141's
-- daily_insights_select is is_family_member(family_id). Since N9-S2 the insight
-- of the day (components/dashboard/ai-home-dashboard.tsx) shows a non-manager
-- only their own reading, but the household's rows (member_id null) are a
-- parent's or adult's reading, and they stayed every member's to read: a
-- document 0266 keeps from a child ("Mum's passport expires in 6 days"), an
-- insurance renewal and its amount, a manager-only Autopilot suggestion.
-- Measured on a replay of main, as a child and as a guest: each read all three
-- over PostgREST, and the child dismissed the household's document insight.
--
-- A RESTRICTIVE select policy, as 0509 and 0528 narrowed reads, so 0141's
-- policies and the inventory probes are untouched: a row of the document,
-- renewal or autopilot kind is read by a parent or adult of its family, or by
-- the member whose reading it is (member_id, through is_self_member). An UPDATE
-- that filters on the table's columns is held to the select policies as well,
-- so a non-manager no longer dismisses the household's row of those kinds
-- either. Every other kind, inserts and the service role are unchanged.
--
-- What the app sees: a non-manager's own candidate of one of those kinds is not
-- shown once the household has that day's row (their ignoreDuplicates insert
-- conflicts silently, and the re-read finds no row of that kind), the
-- degradation the finding's body accepts. No application change.
--
-- HELD: 0531, requested on #771 in comment 6560944423 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-households-document-renewal-and-autopilot-insights-are-a-parents-or-adults-check.sql
-- and .github/workflows/daily-insight-reading-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.daily_insights') is null then
    raise exception '0531 needs public.daily_insights (0141)';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0531 needs public.can_manage_family(uuid) and public.is_self_member(uuid)';
  end if;
end
$$;

drop policy if exists "A document, renewal or Autopilot insight is a manager's" on public.daily_insights;
create policy "A document, renewal or Autopilot insight is a manager's" on public.daily_insights
  as restrictive for select to authenticated
  using (kind not in ('document', 'renewal', 'autopilot')
         or public.can_manage_family(family_id)
         or (member_id is not null and public.is_self_member(member_id)));

comment on policy "A document, renewal or Autopilot insight is a manager's" on public.daily_insights is
  'The household''s insight of the day of the document, renewal and autopilot kinds is a parent''s or adult''s reading: read by a parent or adult of its family, or by the member whose reading it is (0531, OPSD-O08/O09). Restrictive, so 0141''s daily_insights_select still decides every other kind.';

do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.daily_insights'::regclass) then
    raise exception '0531: daily_insights must have row-level security enabled';
  end if;
  if not exists (select 1 from pg_policy p
                  where p.polrelid = 'public.daily_insights'::regclass
                    and p.polname = 'A document, renewal or Autopilot insight is a manager''s'
                    and not p.polpermissive and p.polcmd = 'r'
                    and p.polroles = array[(select r.oid from pg_roles r where r.rolname = 'authenticated')]) then
    raise exception '0531: the restrictive read on daily_insights is not in place';
  end if;
end
$$;
