-- Bubaly :: 0339 a calendar event names who actually made it
-- ----------------------------------------------------------------------------
-- AUTHZ-021. `public.calendar_events.created_by` carries no attribution
-- boundary. 01050_calendar_events_rls_repair.sql is the WHOLE of this table's
-- policy set and every verb of it is the same sentence:
--
--     calendar_events_{select,insert,update,delete}
--       USING / WITH CHECK (public.is_family_member(family_id))
--
-- Role-blind AND identity-blind. So a CHILD member may INSERT an event carrying
-- a PARENT's uid in `created_by`, and — because UPDATE is the same sentence —
-- may afterwards REWRITE an existing row's `created_by` to anyone, including to
-- NULL, erasing an author.
--
-- The forgery is reachable with no AI involvement at all. lib/capture/save.ts
-- :184 takes `userId` as a caller-supplied argument of `CaptureSaveInput` and
-- writes it straight into `created_by` through the BROWSER client, so the value
-- crosses into the client and comes back as a function parameter. Nothing in
-- the database constrains it.
--
-- It reaches a screen. app/(app)/dashboard/workload/page.tsx:29 is the only
-- select list in app/, lib/ or components/ that names `created_by` on this
-- table; components/modules/workload-module.tsx:50 maps the uid to a member and
-- lib/workload/balance.ts:117 scores each organized event as 12 minutes of
-- "invisible labour". Forty forged rows credit a parent with ~480 minutes they
-- did not carry.
--
-- ── WHY THIS IS NOT `created_by = auth.uid()` ─────────────────────────────────
--
-- Three migrations carrying the numbers 0339/0340/0342 pinned exactly that and
-- were REJECTED (b48bac22; they are not in this tree). The predicate is false
-- BY DESIGN here. `calendar.createEvent` is a registered tool
-- (lib/ai/tools/calendar.ts:49, lib/ai/tools/registry.ts:73), so
-- `performApproved`'s `case 'tool':` (lib/services/approvals/index.ts:709)
-- builds `actingScope` from `scopeForApprovedWork`, which at :632 returns
-- `{ ...scope, userId: asker.user_id ?? scope.userId }` while leaving
-- `scope.db` as the APPROVING parent's cookie-bound session. `executeTool`
-- copies the scope without touching `db`, so lib/services/calendar/index.ts:113
-- writes the ASKER's uid through the APPROVER's client. A bare identity pin
-- breaks the path it claims to protect, and
-- tests/approval-replay-attribution.test.ts guards that behaviour on purpose.
--
-- Correction to the AUTHZ-021 brief, re-measured and recorded so the next
-- reader does not re-derive it: lib/services/approvals/index.ts:500 is NOT that
-- site. `materializeConciergePlan` is reached from `case 'concierge_plan':`
-- (:679) via `runConciergePlan` (:556), which passes the BARE decider scope —
-- `scopeForApprovedWork` is called at exactly one place, :709, and its result
-- goes only to `executeTool`. That line's `created_by` IS `auth.uid()`. The
-- `case 'tool':` branch is the real replay exposure. Second correction:
-- app/api/ai/flyer/route.ts writes `created_by: userId` at :75 where
-- `userId = ctx.user.id` (:52) — it is a self writer, not a NULL writer.
--
-- ── THE SHAPE, AND ITS SHIPPED PRECEDENT ─────────────────────────────────────
--
-- 0272_rsvp_is_first_person.sql already answered this exact constraint one
-- table over, on `event_rsvps`, which the approval replay also writes:
-- `public.is_self_member(member_id) or public.can_manage_family(family_id)`
-- (:70-88). tests/rsvp-first-person-rls.test.ts:69 carries the case "keeps a
-- manager able to write anyone's row, which is what lets an approval replay".
-- That is the house's already-accepted answer to this blocker, and this
-- migration copies it rather than inventing a narrower one.
--
-- A narrower shape WAS considered and rejected: requiring, on the manager
-- branch, that `created_by` be on that family's roster. Measured: `fm_insert`
-- (0118_rls_drift_repair.sql:70-71) is `with check (can_manage_family
-- (family_id))` with NO constraint on `user_id`, so the identical predicate
-- that satisfies the manager branch also grants unconstrained roster minting in
-- the same session. A roster conjunct would remove no authority from the party
-- it names while adding a SECURITY DEFINER function and a claimed gate whose
-- key the gated party holds. It is not written here.
--
-- The manager branch is ALWAYS satisfied by a replay — verified, not assumed:
-- `openForDecision` refuses any decision where `!isManager(scope.role)`
-- (lib/services/approvals/index.ts:246); `MANAGER_ROLES = ['parent','adult']`
-- (lib/constants/roles.ts:24-27); `public.can_manage_family` is
-- `role in ('parent','adult') and is_active` (0003_functions_triggers.sql
-- :22-29). The two sets are identical.
--
-- `created_by` REFERENCES auth.users(id) (0002_tables.sql:99), NOT
-- family_members(id), so a bare `= auth.uid()` compare is the correct form for
-- the self branch — 0333's shape, not 0338's `exists (… fm.user_id = auth.uid())`
-- form. Checked against the column definition, not inferred from the name.
--
-- ── NULL IS ADMITTED, DELIBERATELY ───────────────────────────────────────────
--
-- Two RLS-BOUND writers insert with no `created_by` key at all, and a pin that
-- refused NULL would break both:
--   * app/api/calendar/sync/route.ts:115-125 — ICS import. `createServer()` at
--     :86, so RLS applies. The row literal has no `created_by` member.
--   * lib/server/calendar-feeds.ts:54 — subscribed-feed sync. Its `supabase`
--     parameter is `await createServer()` from
--     app/(app)/dashboard/sync/feeds/actions.ts:31 and :54. `FeedEventRow`
--     (lib/calendar/feeds.ts:47-59) has no `created_by` member. THIS SITE IS
--     NOT NAMED IN THE AUTHZ-021 BRIEF. Its cron sibling
--     (app/api/cron/calendar-feeds/route.ts:35) runs service-role and would
--     have survived a NULL-refusing pin, which would have made the breakage
--     look intermittent rather than total.
-- supabase/seed.sql:56 writes `created_by` explicitly NULL, so an unattributed
-- row is the normal shape of this table in a freshly reset database.
--
-- ── WHY UPDATE IS A TRIGGER AND NOT A POLICY ─────────────────────────────────
--
-- The trigger is not tidiness; without it this migration is defeated in two
-- statements. A member may insert with `created_by` NULL (admitted above) and
-- then UPDATE it to a parent's uid under 01050's role-blind update policy. An
-- INSERT-only guard on this table guards nothing.
--
-- It also closes a bypass a policy alone cannot: PostgreSQL applies an INSERT
-- WITH CHECK only to rows appended by the INSERT path, so
-- `INSERT … ON CONFLICT DO UPDATE` — which is what supabase-js `.upsert()`
-- emits, and this table has three usable conflict targets (`id`,
-- `feed_id,external_uid`, `family_id,onboarding_key`) — would otherwise write
-- `created_by` straight past the guard.
--
-- It is a TRIGGER rather than an UPDATE policy for 0338's reason, re-derived
-- here: no writer sends `created_by` on UPDATE — `updateEvent` assembles a
-- fixed patch (lib/services/calendar/index.ts:283-300) and `UpdateEventPatch`
-- has no member for it; app/(app)/dashboard/trip-intel/actions.ts:108-115,
-- app/(app)/dashboard/conflicts/actions.ts:26 and
-- lib/services/onboarding-calendar/index.ts:150 all patch fixed field lists. A
-- policy's WITH CHECK would therefore evaluate the row's EXISTING author and
-- refuse a member legitimately editing an event someone else created — which
-- 01050 allows on purpose. A preserving trigger costs those sites nothing.
--
-- ── WHY THE PRESERVE IS GUARDED BY `pg_trigger_depth() = 1` ──────────────────
--
-- This is the correction that distinguishes this migration from the rejected
-- one, and it is the defect the reviews of every candidate design missed or
-- measured wrongly in both directions. MEASURED on a replayed database:
--
--   `created_by uuid references auth.users(id) ON DELETE SET NULL`
--   (0002_tables.sql:99). Deleting an auth user makes the FK's own referential
--   action issue `UPDATE calendar_events SET created_by = NULL`. That is a real
--   UPDATE and a BEFORE UPDATE trigger fires on it. An UNCONDITIONAL
--   `new.created_by := old.created_by` reverts the NULL; because OLD and NEW
--   then compare equal, `RI_FKey_check_upd` short-circuits and raises NOTHING.
--   Measured result: `delete from auth.users …` reports DELETE 1 with no error
--   and leaves calendar_events holding a DANGLING reference to a user row that
--   no longer exists.
--
-- So an unconditional preserve does not merely "keep the author"; it silently
-- breaks the ON DELETE SET NULL the column declares, defeats account erasure
-- (app/(app)/family/child-login-actions.ts:62,:69,:79 call
-- `admin.auth.admin.deleteUser`), and leaves data that a later
-- `ALTER TABLE … VALIDATE CONSTRAINT` or a dump/restore cannot reproduce.
--
-- MEASURED discrimination: an application UPDATE fires this trigger at
-- `pg_trigger_depth() = 1`; the FK's referential action fires it at 2. Guarding
-- the preserve on depth 1 keeps every member-facing freeze (verified below in
-- the probe) while letting the constraint do the job it declares. Grepped: no
-- migration in supabase/migrations UPDATEs calendar_events, and the only other
-- non-internal trigger on the table is `trg_set_updated_at`, so there is no
-- legitimate nested application UPDATE for the depth test to misclassify.
--
-- Note for whoever revisits 0338: `public.attribution_is_immutable()` (0338
-- :110-121) has this same defect, unguarded, on `medication_doses.logged_by`
-- and `care_log.created_by` — both `ON DELETE SET NULL` to auth.users
-- (verified in pg_constraint: confdeltype = 'n'). It is inherited, not invented
-- here, and it is NOT fixed by this migration, which deliberately does not
-- touch a function another migration owns.
--
-- A DEDICATED function is created rather than widening 0338's. 0338's assigns
-- `new.logged_by := old.logged_by` unconditionally and calendar_events has no
-- `logged_by` column, so attaching it unchanged would raise
-- `record "new" has no field "logged_by"` on every UPDATE. Replacing 0338's
-- function in place would work only while that replacement stayed the last
-- word, and docs/PENDING_PROD_MIGRATIONS.md records that applying is manual,
-- piecemeal and currently broken — so a re-run of 0338 after this would revert
-- the shared function and abort EVERY UPDATE of calendar_events. Separate
-- functions, for the reason 0333's header gives about policies: each migration
-- keeps owning what it named.
--
-- The preserve is otherwise UNCONDITIONAL, including a rewrite to NULL. The
-- rejected draft preserved only a non-NULL rewrite, so any member could still
-- ERASE another member's authorship while its header claimed the author was
-- fixed at insert.
--
-- ── WHAT THIS LEAVES OPEN, ON THE RECORD ─────────────────────────────────────
--
--   * PARENT-TO-CHILD FORGERY IS NOT CLOSED. `can_manage_family` is a role, so
--     any parent or adult may still insert an event naming any uid. This is the
--     identical trade 0272 accepted for event_rsvps and it is forced by the
--     approval-replay path.
--   * ANONYMOUS INSERTION IS NOT CLOSED. Any member may still insert with
--     `created_by` NULL. Measured mitigation, and the limit of it:
--     lib/workload/balance.ts:107 is `if (!e.createdBy) continue;`, executed
--     BEFORE the total is summed at :115-120, so a NULL row credits nobody and
--     inflates nobody's share. But app/(app)/dashboard/workload/page.tsx:29-30
--     reads `.gte('starts_at', weekAgo).limit(1000)` with NO `.order()`, and
--     `idx_events_family_time` is on (family_id, starts_at), so a member who
--     inserts 1000 unattributed events dated just after `weekAgo` can push
--     every real event out of the row budget and flatten the chart to zero for
--     everyone. That is a DISPLAY-TRUNCATION defect in the page, it exists
--     today unchanged, this migration neither causes nor closes it, and it is
--     recorded here rather than left for the next reader to discover — the fix
--     belongs in the page (an `.order()` and/or a server-side
--     `created_by is not null` filter), not in RLS.
--   * SEIZE-AND-REWRITE IS NOT CLOSED, AND THIS MIGRATION MAKES IT PERMANENT.
--     01050's UPDATE policy stays role-blind, so a child may PATCH every
--     substantive field of a parent-created row — title, description, location,
--     category, assignee_id, starts_at, ends_at — and the trigger then
--     GUARANTEES the parent's uid survives on content the child wrote. That is
--     "an event claiming to have been created by someone who did not create it"
--     by a second route, and after this migration no application path at any
--     privilege level can correct a wrong `created_by` (the trigger fires for
--     service_role too; BYPASSRLS does not bypass triggers). The remedies are
--     delete-and-reinsert or owner-level DDL. AUTHZ-021 is therefore closed on
--     INSERT ONLY; the rewrite route is a live finding, recorded as its own.
--   * DELETE IS UNCHANGED and stays role-blind. A child can still destroy a
--     parent's events. That is a strictly larger hole than this one, out of
--     this item's scope, and shipping this must not be read as closing it.
--   * SELECT IS UNCHANGED. Seeing the household's calendar is the point.
--   * SERVICE-ROLE AND OWNER WRITERS bypass the policy, which names
--     `authenticated`: app/onboarding/actions.ts:636,
--     lib/assistant/service.ts:381, lib/services/onboarding-calendar/index.ts
--     :157, lib/ai/runs/executor.ts and every supabase/seed*.sql run as
--     `postgres`. No migration sets FORCE ROW LEVEL SECURITY (grepped), so the
--     seeds that write a third party's uid — seed_calendar.sql:89,
--     SEED_ALL.sql:6252 — keep working. The TRIGGER does still fire for them,
--     and there is one observable consequence: app/onboarding/actions.ts:636
--     upserts `onConflict 'family_id,onboarding_key'` with `created_by` present
--     in the row (built at :630), so `created_by` IS in the generated DO UPDATE
--     SET list and a re-run now PRESERVES the first importer's uid instead of
--     restamping it. Harmless in practice — `onboarding_key` embeds
--     `onboardingRunKey(auth.user.id, …)`, so a conflicting row is always the
--     same user's and the discarded value equals the preserved one — but it is
--     a real behaviour change and is named rather than glossed.
--
-- ── SHAPE CONSTRAINTS THIS SPELLING OBEYS ────────────────────────────────────
--   * `as restrictive for insert to authenticated` — NOT `for all`, NOT PUBLIC.
--     docs/audit/family-self-read-check.sql:85-88 detects a deliberate
--     deny-all quarantine as (polpermissive false AND polcmd '*' AND polroles =
--     array[0::oid]). Written `for all` or to PUBLIC, calendar_events would be
--     misclassified as quarantined and that probe would INVERT its invariant.
--   * The predicate carries no bare `true` branch, which
--     docs/audit/blanket-policy-check.sql:86 flags for a non-service role.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

-- ── The author is fixed at insert ───────────────────────────────────────────
create or replace function public.calendar_attribution_is_immutable()
returns trigger language plpgsql as $fn$
begin
  -- Preserve rather than refuse: no calendar writer sends created_by on UPDATE,
  -- so a checking policy would fail the legitimate edit of somebody else's
  -- event while a preserve simply keeps the truth that was recorded.
  --
  -- Depth 1 is an application UPDATE. Depth 2 is the ON DELETE SET NULL action
  -- of calendar_events_created_by_fkey, which must be allowed through or
  -- deleting an auth user silently leaves a dangling reference (measured; see
  -- the header). The preserve is otherwise unconditional, so a rewrite to NULL
  -- is an erasure this refuses too, not only a rewrite to another person.
  if pg_trigger_depth() = 1 then
    new.created_by := old.created_by;
  end if;
  return new;
end $fn$;

comment on function public.calendar_attribution_is_immutable() is
  '0339 (AUTHZ-021): calendar_events.created_by is fixed at insert against application UPDATEs (pg_trigger_depth 1), while the column''s own ON DELETE SET NULL referential action (depth 2) still passes. Deliberately separate from attribution_is_immutable(), which 0338 owns and which touches logged_by, a column calendar_events does not have.';

do $$
begin
  if to_regclass('public.calendar_events') is null then
    return;
  end if;

  -- RESTRICTIVE, so 01050 keeps owning calendar_events_insert — the calendar
  -- surface's tests keep describing the live policy — and so no future
  -- permissive INSERT written out of habit can grant past this one.
  drop policy if exists calendar_events_author_guard on public.calendar_events;
  create policy calendar_events_author_guard on public.calendar_events
    as restrictive for insert to authenticated
    with check (
      created_by is null
      or created_by = auth.uid()
      or public.can_manage_family(family_id)
    );

  drop trigger if exists calendar_events_attribution_immutable on public.calendar_events;
  create trigger calendar_events_attribution_immutable
    before update on public.calendar_events
    for each row execute function public.calendar_attribution_is_immutable();
end $$;

-- The guard names `authenticated`, and a restrictive policy only ANDs with a
-- request made AS a role it names — for an anonymous request it is simply
-- absent, leaving the grant layer as the last line. Supabase's default
-- privileges hand `anon` arwdDxt on every table created in `public`, and this
-- one still carried them. Not exploitable as it stands — 01050's permissive
-- policies are TO PUBLIC and so do cover anon, but is_family_member(family_id)
-- is false with a null auth.uid() — and this does not claim otherwise; closed
-- for the reason 0290, 0322, 0328 and 0333 give: one future policy written
-- `TO public` would find the grant waiting. SELECT is deliberately left alone.
revoke insert, update, delete, truncate on public.calendar_events from anon;

do $$
declare
  guard_check  text;
  guard_roles  name[];
  insert_check text;
  select_qual  text;
  update_qual  text;
  fn_def       text;
begin
  if to_regclass('public.calendar_events') is null then
    return;
  end if;

  if has_table_privilege('anon', 'public.calendar_events', 'INSERT') then
    raise exception '0339: anon still holds INSERT on calendar_events';
  end if;

  -- A migration that silently created nothing is worse than one that failed: a
  -- probe would then be asserting a boundary that only looks present.
  select with_check, roles into guard_check, guard_roles from pg_policies
   where schemaname = 'public' and tablename = 'calendar_events'
     and policyname = 'calendar_events_author_guard'
     and permissive = 'RESTRICTIVE' and cmd = 'INSERT';
  if guard_check is null then
    raise exception '0339: the restrictive author guard is missing from calendar_events';
  end if;

  -- All three branches, named individually. Losing the NULL branch breaks ICS
  -- import and subscribed-feed sync; losing the auth.uid() branch breaks every
  -- ordinary writer; losing the manager branch breaks the approval replay. A
  -- guard that only asserted "a policy exists" would notice none of those.
  if guard_check not like '%created_by IS NULL%' then
    raise exception '0339: the author guard no longer admits a NULL author — ICS import and feed sync write one: %', guard_check;
  end if;
  if guard_check not like '%created_by = auth.uid()%' then
    raise exception '0339: the author guard no longer admits the caller''s own id: %', guard_check;
  end if;
  if guard_check not like '%can_manage_family(family_id)%' then
    raise exception '0339: the author guard no longer admits a manager — approved AI work replays as the asker and would fail: %', guard_check;
  end if;

  -- The spelling is load-bearing, not cosmetic.
  -- docs/audit/family-self-read-check.sql:85-88 classifies a table as
  -- QUARANTINED on (restrictive, cmd '*', roles {0}); rewritten `for all` or TO
  -- PUBLIC, this policy would make that probe invert its invariant and fail
  -- calendar_events for being readable.
  if guard_roles is distinct from array['authenticated']::name[] then
    raise exception '0339: the author guard must be granted TO authenticated only, or family-self-read-check misreads calendar_events as quarantined: %', guard_roles::text;
  end if;

  -- The freeze is half the fix. Without it the policy is defeated by an
  -- insert-then-update pair, and by INSERT … ON CONFLICT DO UPDATE, which an
  -- INSERT WITH CHECK never sees.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.calendar_events'::regclass
      and tgname = 'calendar_events_attribution_immutable'
      and not tgisinternal
  ) then
    raise exception '0339: the attribution-freeze trigger is missing from calendar_events';
  end if;

  -- THE ONE A FUTURE EDIT IS MOST LIKELY TO UNDO. Dropping the depth guard
  -- turns the preserve unconditional again, which silently defeats
  -- calendar_events_created_by_fkey's ON DELETE SET NULL and leaves dangling
  -- references behind every account deletion — with no error at the time.
  fn_def := pg_get_functiondef('public.calendar_attribution_is_immutable()'::regprocedure);
  if fn_def not like '%pg_trigger_depth()%' then
    raise exception '0339: calendar_attribution_is_immutable() lost its pg_trigger_depth guard — the FK''s ON DELETE SET NULL would be reverted and auth.users deletion would leave dangling references';
  end if;
  if fn_def not like '%new.created_by := old.created_by%' then
    raise exception '0339: calendar_attribution_is_immutable() no longer preserves created_by — the insert-then-update defeat is reopened';
  end if;

  -- This guard only ANDs. If 01050's permissive INSERT condition ever drifts,
  -- a restrictive pin on the author would keep passing while the family
  -- boundary it assumes had gone.
  select with_check into insert_check from pg_policies
   where schemaname = 'public' and tablename = 'calendar_events'
     and policyname = 'calendar_events_insert';
  if insert_check is null or insert_check not like '%is_family_member(family_id)%' then
    raise exception '0339: calendar_events_insert no longer carries 01050''s is_family_member(family_id): %',
      coalesce(insert_check, '<policy missing>');
  end if;

  -- And this migration must not have taken a read away. 01050 exists because
  -- production once had RLS on with this policy missing and the Calendar page
  -- rendered empty.
  select qual into select_qual from pg_policies
   where schemaname = 'public' and tablename = 'calendar_events'
     and policyname = 'calendar_events_select';
  if select_qual is null or select_qual not like '%is_family_member(family_id)%' then
    raise exception '0339: calendar_events_select is gone or no longer family-scoped — reads would break: %',
      coalesce(select_qual, '<policy missing>');
  end if;

  -- The choice of a preserving TRIGGER over an UPDATE policy rests on UPDATE
  -- still being the role-blind sentence 01050 shipped. If that changes, the
  -- reasoning in this header needs re-reading rather than inheriting.
  select qual into update_qual from pg_policies
   where schemaname = 'public' and tablename = 'calendar_events'
     and policyname = 'calendar_events_update';
  if update_qual is null or update_qual not like '%is_family_member(family_id)%' then
    raise exception '0339: calendar_events_update is no longer 01050''s is_family_member(family_id): %',
      coalesce(update_qual, '<policy missing>');
  end if;

  raise notice '0339 OK: a calendar_events row is born naming the person who made it, nobody, or — for a manager, which is what lets an approval replay name the asker — another id; and the author is then frozen against application UPDATEs while the column''s own ON DELETE SET NULL still fires. Parent-to-child forgery, anonymous insertion, content seize-and-rewrite under a frozen author, and DELETE are NOT closed and are recorded in the header.';
end $$;
