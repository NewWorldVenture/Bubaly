-- Onboarding resumes only your own family. (SEC-018, migration 0331)
--
-- `onboarding_claim_family` resumes from onboarding_progress.family_id, and the
-- onboarding action then upserts the caller into that family as a PARENT with
-- the service role. The row was the user's to write, family_id included, so a
-- fresh account that named someone else's family there became its parent and
-- read its password vault (reproduced with real sessions; see 0331).
--
--   a user writes their own row's family_id                    -> REFUSED
--   a row that already names another family is not resumed     -> REFUSED (new family instead)
--   a creator removed from their own family is not re-admitted -> REFUSED (new family instead)
--   a user resumes their own abandoned wizard family           -> allowed  (control)
--   the calendar setup path updates source and status          -> allowed  (control)
--   a first-time user gets a new family                        -> allowed  (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  victim   uuid := '00000000-0000-4000-8000-00000000d501';
  attacker uuid := '00000000-0000-4000-8000-00000000d502';
  creator  uuid := '00000000-0000-4000-8000-00000000d503';
  coparent uuid := '00000000-0000-4000-8000-00000000d504';
  newbie   uuid := '00000000-0000-4000-8000-00000000d505';
  fam_v    uuid := '00000000-0000-4000-8000-00000000d511';
  fam_c    uuid := '00000000-0000-4000-8000-00000000d512';
  got      uuid;
  was_new  boolean;
  first_id uuid;
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (victim, 'claim-victim@example.test'), (attacker, 'claim-attacker@example.test'),
    (creator, 'claim-creator@example.test'), (coparent, 'claim-coparent@example.test'),
    (newbie, 'claim-newbie@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam_v, 'Victim', victim), (fam_c, 'Creator', creator)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam_v, victim, 'Victim', 'parent', true),
    (fam_c, creator, 'Creator', 'parent', false),     -- removed from their own family
    (fam_c, coparent, 'Co-parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = excluded.is_active;

  -- ── 1. a user tries to point their own row at another family ────────────
  perform set_config('request.jwt.claims', json_build_object('sub', attacker::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.onboarding_progress (user_id, family_id, source, status) values (attacker, fam_v, 'wizard', 'in_progress');
    raise warning 'BREACH: a user created an onboarding row naming another family';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- The row may already name the victim (written before 0331, or by anything
  -- else); the function must still refuse to resume it.
  insert into public.onboarding_progress (user_id, family_id, source, status) values (attacker, fam_v, 'wizard', 'in_progress')
  on conflict (user_id) do update set family_id = fam_v, status = 'in_progress';
  perform set_config('request.jwt.claims', json_build_object('sub', attacker::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.onboarding_progress set family_id = fam_v where user_id = attacker;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a user rewrote their onboarding row to name another family (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  select c.family_id, c.created into got, was_new from public.onboarding_claim_family(attacker, 'Attacker', 'UTC') c;
  if got = fam_v then
    raise warning 'BREACH: onboarding_claim_family resumed another family for a stranger — the action would make them its parent';
    failures := failures + 1;
  elsif not was_new then
    raise warning 'CONTROL FAILED: the stranger was neither given the victim nor a new family (got %)', got;
    failures := failures + 1;
  end if;
  reset role;
  select count(*) into n from public.onboarding_progress where user_id = attacker and family_id = fam_v;
  if n > 0 then
    raise warning 'the attacker''s progress row still names the victim family after a fresh claim';
    failures := failures + 1;
  end if;

  -- ── 2. a creator removed from their own family ──────────────────────────
  insert into public.onboarding_progress (user_id, family_id, source, status) values (creator, fam_c, 'wizard', 'in_progress')
  on conflict (user_id) do update set family_id = fam_c, status = 'in_progress';
  perform set_config('request.jwt.claims', json_build_object('sub', creator::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select c.family_id into got from public.onboarding_claim_family(creator, 'Again', 'UTC') c;
  if got = fam_c then
    raise warning 'BREACH: a creator removed from their family was resumed into it — the action would re-admit them as a parent';
    failures := failures + 1;
  end if;
  reset role;

  -- ── 3. controls: the legitimate paths ───────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', newbie::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select c.family_id, c.created into first_id, was_new from public.onboarding_claim_family(newbie, 'Newbie', 'UTC') c;
  if first_id is null or not was_new then
    raise warning 'CONTROL FAILED: a first-time user did not get a new family';
    failures := failures + 1;
  end if;
  -- an interrupted wizard submits again before its owner membership exists
  select c.family_id, c.created into got, was_new from public.onboarding_claim_family(newbie, 'Newbie', 'UTC') c;
  if got is distinct from first_id or was_new then
    raise warning 'CONTROL FAILED: an interrupted wizard was not resumed onto its own family (got %, new %)', got, was_new;
    failures := failures + 1;
  end if;
  -- prepareCalendarFamily resets source and status on the user's own row
  begin
    update public.onboarding_progress set source = 'wizard', status = 'in_progress' where user_id = newbie;
    get diagnostics n = row_count;
    if n <> 1 then raise warning 'CONTROL FAILED: the calendar setup path could not update its own progress row (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: the calendar setup path lost the columns it updates';
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'onboarding can resume a family that is not yours: % finding(s)', failures;
  end if;
  raise notice 'OK: a stranger or removed creator gets a new family; your own interrupted wizard resumes.';
end
$probe$;

rollback;
