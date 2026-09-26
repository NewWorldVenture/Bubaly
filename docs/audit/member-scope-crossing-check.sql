-- ── K-01 A member id is not a household ─────────────────────────────────────
--
-- Every family table carries family_id and its RLS reads
-- `is_family_member(family_id)`. That predicate is deliberately membership-WIDE:
-- it admits every family the caller belongs to, because a parent with a
-- household on each side of a separation is one account with two families, and
-- both must work. Nothing is wrong with the policy.
--
-- What is wrong is reading a row by member_id and calling the result "this
-- family's data". `/api/ai/health/coach` and `/api/behavior/insight` both took
-- a memberId out of the request body and filtered on it alone, so for a
-- two-household parent the answer was drawn from whichever household the named
-- member happened to be in — while the feature gate, the plan check and the
-- page around it had all been decided against the ACTIVE family.
--
-- The premise cannot be established by reading the policy: `is_family_member`
-- is a function, symptom_logs' policy is created inside an `execute format(...)`
-- loop (behavior_logs' is a plain CREATE POLICY, 00730:35-38), and the
-- app-level filter is what actually scopes the query. So prove it
-- behaviourally, from both ends:
--
--   1. a two-family parent reading by member_id alone DOES cross into the
--      other household (the defect's premise),
--   2. adding `family_id = <active>` — the fix — returns nothing (the filter
--      is what scopes it, not RLS), and
--   3. a stranger reads nothing either way (so 1 is a scoping gap and not RLS
--      being off, which would be a far larger finding).
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/member-scope-crossing-check.sql

\set FA '00000000-0000-4000-8000-0000000000d1'
\set FB '00000000-0000-4000-8000-0000000000d2'
\set UD '00000000-0000-4000-8000-0000000000d3'
\set UO '00000000-0000-4000-8000-0000000000d4'
-- The negative control's household: a THIRD family that UO — the user in
-- neither Alpha nor Beta — IS an active member of, and a ward of it with logs
-- of its own.
\set FE '00000000-0000-4000-8000-0000000000dc'
\set MC '00000000-0000-4000-8000-0000000000dd'

-- One transaction, rolled back at the end. A probe that seeds rows and then
-- deletes them leaves those rows behind the moment an assertion raises, and
-- every probe run.sh executes after it inherits them. A rollback cleans up on
-- both paths, including the aborting one.
begin;

-- Pin the control's anchors INTO the transaction. psql does not interpolate
-- :variables inside a $$…$$ body, so a do-block that needs FE or MC would have
-- to repeat the literal — and a repeated literal drifts. The control block reads
-- these back with current_setting(), so it cannot disagree with the seed below
-- about which rows are Gamma's. (is_local = true: they die with the
-- transaction, like everything else in this file.)
select set_config('probe.fe', :'FE', true), set_config('probe.mc', :'MC', true);

-- Seed: one parent in TWO households, each with a child, and an unrelated user.
insert into auth.users (id, email) values (:'UD','d-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UO','d-stranger@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA','Alpha House',:'UD') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FB','Beta House', :'UD') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA',:'UD','Parent A','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FB',:'UD','Parent B','parent',true) on conflict do nothing;

-- The child whose health and behaviour live in the OTHER household.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000d5', :'FB', null, 'Beta Child', 'child', true)
  on conflict do nothing;

insert into public.symptom_logs (family_id, member_id, symptom, severity, started_at, status)
  values (:'FB','00000000-0000-4000-8000-0000000000d5','Headache',2, now(), 'active')
  on conflict do nothing;
insert into public.behavior_logs (family_id, member_id, kind, category, points, occurred_at)
  values (:'FB','00000000-0000-4000-8000-0000000000d5','concern','focus',-1, now())
  on conflict do nothing;

-- ── The negative control's own household ────────────────────────────────────
-- FE is a family UO created, so `is_family_member(FE)` answers YES for the very
-- user `is_family_member(FA)` and `is_family_member(FB)` answer no for. MC is a
-- ward of that house — user_id null, the same managed-child shape the Beta child
-- has — with a symptom log and a behaviour log of its own, so the control reads
-- ITS OWN rows and cannot perturb a single count asserted below: every one of
-- them filters on the Beta child's member_id.
insert into public.families (id, name, created_by) values (:'FE','Gamma House',:'UO') on conflict do nothing;
-- on_family_created files the creator as a 'parent' already. That trigger's
-- function was written in 0003:67-84 and REPLACED WHOLE by
-- 0257_family_ai_settings.sql:78-98, which also drops and re-creates the trigger
-- (0257:95-98) and is the LAST migration to define either — 0300's only mention
-- is a comment (0300:11). Cited to the last definer for the reason the control
-- block gives below; the membership insert is byte-identical across the two
-- (role 'parent', `on conflict (family_id, user_id) do nothing`), and 0257
-- appends a family_ai_settings row after the subscriptions row. Upsert rather
-- than assume, because a seed whose membership is wrong fails the control for a
-- reason that is not the control's, and a control that flags a healthy schema
-- is worse than no control. `is_active = true` is the part the predicate reads.
-- 'parent' is symmetry, not mechanism: it is the role UD holds in Alpha and
-- Beta, but is_family_member (0003:5-11) tests family_id, user_id and is_active
-- and never reads role — unlike can_manage_family and is_family_admin in the
-- same file — so role is not something the predicate under test can differ on.
-- What the symmetry buys is only that a future swap to a role-aware predicate
-- (0297 made exactly that swap on child_logins) would not fail this control for
-- a role reason and get misread as a boundary result. The one thing that
-- differs between the control and the refusals it attributes is the family_id.
--
-- This upsert is the file's only UPDATE path on family_members, which carries
-- two row triggers no `CREATE TRIGGER` names it in: trg_mark_model_dirty,
-- attached by the `execute format` loop in 0134_model_dirty.sql:59-62 over an
-- array that lists family_members (0134:51-54; function last defined in
-- 0249:21-47 — AFTER, security definer, upserts one family_model_dirty row, and
-- the Alpha/Beta seeds above have already fired it), and
-- trg_family_keeps_a_manager (0299_family_keeps_a_manager.sql:78-81), a
-- `create constraint trigger … deferrable initially deferred` that fires only
-- at COMMIT — which this file never reaches — and would pass anyway, Gamma
-- keeping UO as an active parent. Neither is in a SELECT's path, so neither is
-- in the control's.
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FE',:'UO','Gamma Parent (a member HERE)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MC', :'FE', null, 'Gamma Child', 'child', true) on conflict do nothing;
-- No `on conflict do nothing` on these two, unlike the seeds above: neither
-- table carries a unique constraint these values could collide with (both
-- indexes on each are non-unique, 00801:26-27 and 00730:26-27), so a real error
-- here must be loud rather than swallowed. The one way an insert stores nothing
-- WITHOUT erroring — a BEFORE INSERT row trigger returning NULL, which neither
-- table carries today (their only triggers are set_updated_at and, on
-- behavior_logs, 0338's attribution_is_immutable, both BEFORE UPDATE) — is the
-- case the control's seed pre-check below exists to name, so that it is never
-- misreported as a blind session.
insert into public.symptom_logs (family_id, member_id, symptom, severity, started_at, status)
  values (:'FE',:'MC','Headache',2, now(), 'active');
insert into public.behavior_logs (family_id, member_id, kind, category, points, occurred_at)
  values (:'FE',:'MC','concern','focus',-1, now());

grant select on public.symptom_logs, public.behavior_logs to authenticated;

-- ── NEGATIVE CONTROL: the same actor, the same predicate, the other answer ───
-- IT RUNS FIRST, before assertions 1-3, because it is what makes their result
-- readable. Nothing below is weakened, deleted or skipped: this is ADDED to
-- those three assertions, not substituted for any of them.
--
-- WHICH ASSERTION NEEDS IT, AND WHY NOT THE OTHER TWO. Assertion 1 asserts that
-- rows ARE returned, which no denial can fake, so it attributes itself.
-- Assertion 2's zero is read in the SAME session one statement later with one
-- predicate added, so assertion 1 is already assertion 2's control. Assertion 3
-- is the one with none, and it is the only claim in this file about a BOUNDARY
-- rather than about an application filter: a user outside Alpha and Beta reads
-- neither household's rows. It is a ZERO-ROW claim, and a zero-row claim is
-- satisfied for free by any cause that stops this session reading anything at
-- all.
--
-- THE PREDICATE UNDER TEST. Assertion 3 is one question asked twice:
-- `public.is_family_member(family_id)` — defined once, in
-- 0003_functions_triggers.sql:5-11, as "an is_active family_members row for
-- auth.uid() in that family". The two policies that ask it, each with the LAST
-- migration to create it — not the first, because replaying an older migration
-- from memory is how this audit once credited a guard a later migration had
-- already replaced (`grep -rl 'Managers manage child_logins'
-- supabase/migrations` returns 01051 and 0297, and 0297 re-created that policy
-- on a different predicate than 01051 had):
--
--   * symptom_logs — `symptom_logs_all`, `FOR ALL TO authenticated USING
--     (public.is_family_member(family_id)) WITH CHECK (same)`, created by the
--     `tbls` loop in 00801_health_wellness.sql:58-67. Its NAME never appears as
--     a literal anywhere — the loop builds it with `format('%1$s_all', t)` — so
--     the grep that settles this is on the TABLE, and `grep -rl symptom_logs
--     supabase/migrations` returns 00801 and nothing else: 00801 is both the
--     first and the last migration to touch this table at all.
--   * behavior_logs — "Members manage behavior_logs", the same shape, created in
--     00730_behavior_tracking.sql:33-38. `grep -rl 'Members manage
--     behavior_logs'` returns 00730 and 0338, and 0338's hit is a COMMENT line
--     (0338:10, its header table of the four never-narrowed ledgers), not a
--     CREATE POLICY. 0338 ADDS `behavior_logs_attribution_guard` (`as
--     restrictive for insert`) and a BEFORE UPDATE trigger, and 0340 replaces
--     that trigger's function. A restrictive INSERT policy is not in a SELECT's
--     path and neither is a BEFORE UPDATE trigger, so 00730 still governs the
--     read — and the control below is a read, so neither is in ITS path either.
--
--   Neither table was healed by 0118_rls_drift_repair.sql's part C: it skips any
--   table already carrying a policy with cmd in ('SELECT','ALL') (0118:162-167),
--   and both carried a FOR ALL policy before 0118 ran — the replay glob is
--   lexicographic (pg-bootstrap.sh:102) and lexicographic order puts the
--   five-digit 00730 and 00801 ahead of 0118, which is easy to read backwards.
--
-- MECHANISM: an RLS policy, on both tables, covering SELECT. Not a trigger, not
-- a CHECK, not a unique index, not a GRANT. The only revoke in the corpus that
-- reaches either table is 0338:154's `revoke insert, update, delete, truncate …
-- from anon`, issued through a loop whose array names behavior_logs (0338:148) —
-- so `grep -rn revoke` does not print the table name, and reading only that grep
-- would miss it. It still does not bear on this probe: it names neither SELECT
-- nor `authenticated`, the role this probe acts as. Nothing revokes anything
-- from `authenticated`; pg-bootstrap.sh:54 hands that role every table privilege
-- by default privilege before any migration runs, and the line above re-grants
-- SELECT explicitly regardless.
--
-- THE CONTROL. So the control is UO — the same session, the same role, the same
-- `request.jwt.claim.sub`, the same `select count(*) … where member_id = …`
-- statement — reading a symptom log and a behaviour log in Gamma, the third
-- household UO IS an active member of. Exactly ONE thing changes: the family_id
-- that is_family_member() is asked about. Those two reads MUST return a row. If
-- assertion 3's zeroes come from the policy, this one lands. If they come from a
-- dead `auth.uid()`, a revoked SELECT, a column denial or a restrictive policy
-- added later for an unrelated rule, this one reads zero too and the probe goes
-- red — which is exactly what you want, because the probe's attribution was
-- wrong.
--
-- WHAT IT WOULD CATCH. Each of these leaves assertion 3 — this file's only
-- boundary claim — GREEN as the file stands today, and the first of them leaves
-- the probe red for the WRONG reason:
--
--   * A DEAD `auth.uid()` — one typo in `request.jwt.claim.sub` here, or a
--     rename of that setting in pg-bootstrap.sh:57 — makes is_family_member()
--     answer no for EVERY caller. Assertion 3 then passes for a reason that has
--     nothing to do with scoping, and the only thing that goes red is assertion
--     1, whose message tells the reader that K-01's premise no longer holds and
--     sends them to re-derive the application filter. The control names the real
--     cause instead, in one line: UO cannot read UO's OWN household.
--   * `is_family_member(family_id)` loosened to `true` for every authenticated
--     caller WOULD be caught by assertion 3 — but only while nothing ELSE is
--     refusing UO. Add one restrictive SELECT policy to either table for an
--     unrelated rule and assertion 3 reads zero for THAT reason, and keeps
--     printing OK with the family predicate gone. This is the read-side twin of
--     the guard-trigger case: this repository refuses writes with guard triggers
--     in 0223, 0305, 0326 and 0331, so a later rule landing on a table this
--     probe reads is not hypothetical. A PRIVILEGE failure is the other half of
--     that class and behaves differently — it RAISES rather than returning zero,
--     so it turns the run red by itself; what it does not do is say why, and
--     that is the paragraph on column fidelity below.
--   * UO IS NOW A MEMBER OF SOMETHING, which is the threat model's actual actor.
--     Before this control UO belonged to no household at all, so assertion 3's
--     zero was as consistent with "a user with no family_members row reads
--     nothing anywhere" as with "Alpha and Beta are scoped". Those are not the
--     same sentence, and only the second is the one K-01 rests on. The seed
--     comment above stays true either way: UO is still in NEITHER Alpha nor
--     Beta, which is all assertion 3 requires of it.
--
-- WHAT IT WOULD NOT CATCH — the residual, named so nobody reads more into the
-- green line than it says. The control proves UO's session can read SOME row of
-- each table: its own household's. It does not prove that is_family_member is
-- the ONLY thing refusing UO the Beta rows. A later restriction that is row- or
-- family-SCOPED — one that refuses Beta's rows to UO while leaving Gamma's
-- readable (a restrictive SELECT policy keyed on a per-family flag, say, or a
-- clause added to the permissive predicate) — passes this control and, with the
-- family predicate also gone, leaves assertion 3's zero misattributed with every
-- line in this file still green. The behavioural control cannot close that: the
-- read that would expose it is UO reading a Beta row with the predicate
-- satisfied, which is the loosening itself. So what this control narrows is the
-- cause of assertion 3's zero, from "anything that blinds the session" to
-- "something that refuses UO Beta's rows specifically". Tying that something to
-- the named policy is the job of the ATTRIBUTION PIN at the end of this file,
-- which asserts against pg_policies what the header above only narrates:
-- exactly one permissive SELECT-covering policy per table, its predicate
-- EXACTLY is_family_member(family_id), and no restrictive policy covering
-- SELECT on either. A family-scoped refusal has to land as one of those — a new
-- restrictive policy, or a clause added to the permissive one's predicate — and
-- either turns that block red. The one shape it does not see is a clause added
-- inside is_family_member's own body; the pin says so where it names what it
-- checks.
--
-- THE CONTROL'S SELECT NAMES THE SAME COLUMN THE READ UNDER TEST DOES —
-- `member_id`, in the WHERE clause, not some convenient other column, for the
-- reason the child_logins control repoints `user_id` rather than only renaming.
-- Stated without overclaiming, because this probe is not the write case: the
-- table-level `grant select` above masks a column-level revoke while it stands
-- (Postgres holds table and column privileges as separate ACL entries and the
-- table grant suffices on its own), so column fidelity here is insurance against
-- the day that grant is narrowed to a column list, not a hole reachable now.
--
-- Contamination: none, in either direction. The control's SEED does plant rows
-- — family FE, two family_members rows, one symptom_logs row, one behavior_logs
-- row, and through the triggers those inserts fire a subscriptions row and a
-- family_ai_settings row (on_family_created, 0257:78-98) and a
-- family_model_dirty row (trg_mark_model_dirty, 0134:59-62). The control's
-- do-block itself only reads. Nothing the seed planted is counted by any
-- assertion below: every count there filters `member_id = <the Beta child, …d5>`
-- and Gamma's rows carry member_id …dd, a different family_members row in a
-- different family. And the whole file is one transaction ending in `rollback`,
-- so none of it reaches the probes run-probes.sh runs after this one against
-- the same database either. There is therefore no control row to remove before
-- the assertions run.
do $$
declare
  ctl        int;
  seeded     int;
  failures   text[] := '{}';
  -- Pinned to the LITERAL assertion 3 uses for its stranger (the
  -- `request.jwt.claim.sub` it sets before its two zero-row reads), because the
  -- control's whole claim is "the same sub". The seed's :'UO' must equal it too,
  -- and the pre-check below is what proves it does rather than assuming it.
  outsider_u constant uuid := '00000000-0000-4000-8000-0000000000d4';
  -- Read back from the transaction, not retyped: see the set_config after `begin`.
  ctl_f      constant uuid := current_setting('probe.fe', true)::uuid;
  ctl_m      constant uuid := current_setting('probe.mc', true)::uuid;
  control_ok boolean := true;
begin
  -- ── Pre-check: the control's seed LANDED, read with RLS out of the way ─────
  -- Still the session role here (the migrations' owner — RLS is not forced on
  -- either table), so these counts see every row. A zero here is a MIS-WIRED
  -- control — an anchor that drifted from the seed, a stranger literal that no
  -- longer matches :'UO', or an insert a trigger swallowed — and it is reported
  -- as that, so the legs below can never say "blind session" about a row that
  -- was never there. This is a precondition on the control, not a claim about
  -- the boundary.
  select count(*) into seeded from public.family_members
    where family_id = ctl_f and user_id = outsider_u and is_active;
  if seeded <> 1 then
    raise exception 'K-01 control MIS-WIRED (not a boundary result): the stranger literal % holds % active membership row(s) in the control household % — the seed and the control disagree about who UO is; fix the probe before reading anything it prints', outsider_u, seeded, ctl_f;
  end if;
  select count(*) into seeded from public.symptom_logs where member_id = ctl_m and family_id = ctl_f;
  if seeded = 0 then
    raise exception 'K-01 control MIS-WIRED (not a boundary result): no symptom_logs row for the control ward % in % exists even with RLS out of the way — the seed did not land (a swallowing BEFORE INSERT trigger?) or the anchor drifted', ctl_m, ctl_f;
  end if;
  select count(*) into seeded from public.behavior_logs where member_id = ctl_m and family_id = ctl_f;
  if seeded = 0 then
    raise exception 'K-01 control MIS-WIRED (not a boundary result): no behavior_logs row for the control ward % in % exists even with RLS out of the way — the seed did not land or the anchor drifted', ctl_m, ctl_f;
  end if;

  -- The same session assertion 3 uses: role, sub and claim role, verbatim.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', outsider_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── Leg 1: symptom_logs — the mirror of assertion 3's first zero ──────────
  begin
    select count(*) into ctl from public.symptom_logs where member_id = ctl_m;
    if ctl = 0 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: the user in neither Alpha nor Beta reads 0 rows of symptom_logs in the THIRD household they ARE an active member of, so the stranger''s zero below measures a blind session and not is_family_member(family_id)');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: that user''s SELECT of symptom_logs in the household they ARE a member of raised %s: %s — a revoked SELECT or a column denial on member_id reads exactly like this, and it would otherwise have aborted this probe with the attribution thrown away', sqlstate, sqlerrm));
  end;

  -- ── Leg 2: behavior_logs — the mirror of assertion 3's second zero ────────
  if control_ok then
    begin
      select count(*) into ctl from public.behavior_logs where member_id = ctl_m;
      if ctl = 0 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: that user reads 0 rows of behavior_logs in the THIRD household they ARE an active member of, so the stranger''s second zero below measures a blind session and not is_family_member(family_id)');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: that user''s SELECT of behavior_logs in the household they ARE a member of raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  perform set_config('role','postgres', true);

  -- A failed control makes both of assertion 3's zeroes unreadable, and it is
  -- assertion 1 — the one assertion that IS self-attributing — that would go red
  -- in its place, pointing the reader at the application filter. Say WHY the
  -- probe cannot speak, here, while the reason is still in hand. The boundary is
  -- not reported as holding and it is not reported as broken: it is reported as
  -- UNPROVEN, and the run is red either way.
  if not control_ok then
    raise exception 'K-01 cross-household READ boundary UNPROVEN (the negative control the assertions below rest on did not hold): %', array_to_string(failures, ' | ');
  end if;

  raise notice 'OK member-scope (control): the user in NEITHER Alpha nor Beta CAN read a symptom log and a behaviour log — the same statement, on the same member_id column — in the third household they ARE a member of, so the zeroes asserted below are NOT a dead auth.uid(), a revoked select or a session that reads nothing at all; that they are is_family_member(family_id) specifically is what the attribution pin at the end of this file checks';
end $$;

do $$
declare
  crossed int;
  scoped  int;
  stranger int;
  failures text[] := '{}';
  child constant uuid := '00000000-0000-4000-8000-0000000000d5';
  alpha constant uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  -- ── As the two-household parent ──────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d3', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. by member_id alone — the shape both routes used.
  select count(*) into crossed from public.symptom_logs where member_id = child;
  if crossed = 0 then
    failures := array_append(failures, 'symptom_logs: a member of both families read NOTHING by member_id — the premise of K-01 no longer holds, so re-derive the finding before trusting the fix');
  end if;

  -- 2. with the active family named — the fix.
  select count(*) into scoped
    from public.symptom_logs where member_id = child and family_id = alpha;
  if scoped <> 0 then
    failures := array_append(failures, format('symptom_logs: family_id = Alpha still returned %s row(s) for a Beta member', scoped));
  end if;

  select count(*) into crossed from public.behavior_logs where member_id = child;
  if crossed = 0 then
    failures := array_append(failures, 'behavior_logs: a member of both families read NOTHING by member_id — the premise of K-01 no longer holds');
  end if;
  select count(*) into scoped
    from public.behavior_logs where member_id = child and family_id = alpha;
  if scoped <> 0 then
    failures := array_append(failures, format('behavior_logs: family_id = Alpha still returned %s row(s) for a Beta member', scoped));
  end if;

  -- ── As someone in neither household ─────────────────────────────────────
  -- Without this control, step 1 could mean "RLS is off", which is a different
  -- and much larger finding than a missing application filter.
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d4', true);
  select count(*) into stranger from public.symptom_logs where member_id = child;
  if stranger <> 0 then
    failures := array_append(failures, format('symptom_logs: a user in NEITHER family read %s row(s) — RLS is not holding at all', stranger));
  end if;
  select count(*) into stranger from public.behavior_logs where member_id = child;
  if stranger <> 0 then
    failures := array_append(failures, format('behavior_logs: a user in NEITHER family read %s row(s) — RLS is not holding at all', stranger));
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception 'member-scope crossing check failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK member-scope: a member id crosses households, family_id does not, and a stranger reads neither';
end $$;

-- ── ATTRIBUTION PIN: the mechanism the prose names is the one in the catalog ─
-- The header above cites, for each table, the LAST migration to create its
-- read-covering policy and asserts there is no other. That was true when it was
-- written; this block makes it true on every run, against pg_policies and
-- pg_proc, the way 0340:209-228 pins a trigger's timing rather than trusting its
-- name. It runs LAST, deliberately: the behavioural assertions speak first, so a
-- predicate loosened to `true` is reported by assertion 3 as the boundary
-- failure it is, and only a run that is behaviourally green gets asked whether
-- the REASON it is green is still the one this file credits. A failure here is
-- not a broken boundary and is not reported as one: it says the attribution
-- must be re-derived, which is what the header's grep discipline is for.
--
-- What it pins, per table: RLS on and not forced (forced would change who the
-- pre-check above sees as); exactly ONE permissive policy whose cmd covers
-- SELECT, by the name the header gives, granted to `authenticated`, with a
-- USING predicate that is EXACTLY `is_family_member(family_id)` — equality, not
-- LIKE, so a predicate tightened with an extra clause (`… and not <flag>`), the
-- family-scoped residual named above, is caught as well as one swapped out; and
-- ZERO restrictive policies whose cmd covers SELECT, which is the other way that
-- residual could land. And the predicate itself: still SECURITY DEFINER, still
-- testing family_id, user_id = auth.uid() and is_active. A fourth condition
-- added INSIDE is_family_member's body would pass this — that is the one
-- residual left open, and it is left open by name: `grep -rn 'function
-- public.is_family_member' supabase/migrations` returns one file today, and a
-- second one is the reader's cue to come back here.
do $$
declare
  t          text;
  expected   text;
  n_perm     int;
  n_restr    int;
  got_qual   text;
  fn_def     text;
  failures   text[] := '{}';
begin
  for t, expected in
    select * from (values ('symptom_logs', 'symptom_logs_all'),
                          ('behavior_logs', 'Members manage behavior_logs')) as v(t, p)
  loop
    if not exists (select 1 from pg_class c where c.oid = ('public.' || t)::regclass
                     and c.relrowsecurity and not c.relforcerowsecurity) then
      failures := array_append(failures, format('%s: row security is off or FORCED — the header describes neither', t));
    end if;

    select count(*) into n_perm from pg_policies p
     where p.schemaname = 'public' and p.tablename = t
       and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
    if n_perm <> 1 then
      failures := array_append(failures, format('%s: %s permissive SELECT-covering policies, the header credits exactly one (%L)', t, n_perm, expected));
    end if;

    select replace(p.qual, 'public.', '') into got_qual from pg_policies p
     where p.schemaname = 'public' and p.tablename = t and p.policyname = expected
       and p.permissive = 'PERMISSIVE' and p.cmd = 'ALL'
       and 'authenticated' = any (p.roles::text[]);
    if got_qual is null then
      failures := array_append(failures, format('%s: no permissive FOR ALL policy named %L granted to authenticated — the policy the header cites has been dropped, renamed or re-scoped; re-derive the attribution', t, expected));
    elsif got_qual <> 'is_family_member(family_id)' then
      failures := array_append(failures, format('%s: %L now reads USING (%s), not is_family_member(family_id) — the zeroes above are attributed to a predicate that is no longer the one in force', t, expected, got_qual));
    end if;

    select count(*) into n_restr from pg_policies p
     where p.schemaname = 'public' and p.tablename = t
       and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL');
    if n_restr <> 0 then
      failures := array_append(failures, format('%s: %s restrictive policy(ies) now cover SELECT — a second refusal is in the read path, and the control above cannot tell a family-scoped one from the policy it credits', t, n_restr));
    end if;
  end loop;

  select pg_get_functiondef(p.oid) into fn_def
    from pg_proc p where p.oid = 'public.is_family_member(uuid)'::regprocedure and p.prosecdef;
  if fn_def is null then
    failures := array_append(failures, 'is_family_member(uuid) is missing or no longer SECURITY DEFINER — 0003:5-11 is not what is in force');
  elsif fn_def not like '%family_id = p_family_id%'
     or fn_def not like '%user_id = auth.uid()%'
     or fn_def not like '%is_active%' then
    failures := array_append(failures, 'is_family_member(uuid) no longer tests family_id, user_id = auth.uid() and is_active as 0003:5-11 wrote it — re-derive what the stranger''s zero measures');
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'K-01 attribution UNPINNED (the boundary held above, but not for the reason this file credits): %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK member-scope (attribution pin): one permissive FOR ALL policy per table, USING is_family_member(family_id) exactly, no restrictive SELECT policy on either, and the predicate is still 0003''s security-definer three-column test';
end $$;

-- Leave the database exactly as it was found: every row above, and the grant,
-- existed only to prove the point.
rollback;
