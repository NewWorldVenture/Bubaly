-- A family's timezone is a zone that exists.
--
-- `families.timezone` decides which local day a routine belongs to, what
-- "today" means, and the day bounds the medication reminder uses.
-- components/modules/family-module.tsx states the failure above the field:
-- `Intl` throws on an unknown zone, every call site catches and degrades to UTC
-- by design, so a typo saved silently and left the family on Greenwich time
-- while the form said "Family profile updated".
--
-- Both application paths refuse a bad zone now. The table did not, and
-- `families_update` is reachable by any manager's JWT.
--
-- THE CONTROLS ARE THE POINT OF THIS PROBE. A guard checking pg_timezone_names
-- alone would be stricter than `Intl` and would reject `CST` and `PST`, which
-- the form offers — closing the product rather than the hole. Postgres keeps
-- IANA names and legacy abbreviations in two catalogues and Intl accepts both,
-- so the rule is the union, and assertions 2-6 are what would catch a guard
-- that narrowed it.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-000000015001';
  pa_uid uuid := '00000000-0000-4000-8000-0000000150a1';
  z        text;
  got      text;
  failures int := 0;
begin
  insert into auth.users (id, email) values (pa_uid, 'tz-parent@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by, timezone)
    values (fam, 'Timezones', pa_uid, 'UTC')
  on conflict (id) do update set timezone = 'UTC';
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, pa_uid, 'Parent', 'parent', true)
  on conflict do nothing;

  -- 1. A typo is refused. This is the defect: `Amercia/Chicago` saved fine and
  --    put the family on Greenwich time with no error anywhere.
  begin
    update public.families set timezone = 'Amercia/Chicago' where id = fam;
    raise warning 'BREACH: a family was saved with the unknown zone Amercia/Chicago';
    failures := failures + 1;
  exception when others then null;
  end;

  select timezone into got from public.families where id = fam;
  if got is distinct from 'UTC' then
    raise warning 'BREACH: the family zone is now % after a refused write', got;
    failures := failures + 1;
  end if;

  -- 2-6. Everything the form offers must still save, or the guard has narrowed
  --      the product. Each of these is accepted by Intl; CST and PST are NOT in
  --      pg_timezone_names and are reached only through pg_timezone_abbrevs, so
  --      they are exactly what a names-only guard would wrongly reject.
  foreach z in array array['America/Chicago', 'Australia/Sydney', 'CST', 'PST', 'Etc/GMT+5', 'US/Central', 'UTC']
  loop
    begin
      update public.families set timezone = z where id = fam;
      select timezone into got from public.families where id = fam;
      if got is distinct from z then
        raise warning 'CONTROL FAILED: the zone % did not persist (got %)', z, got;
        failures := failures + 1;
      end if;
    exception when others then
      raise warning 'CONTROL FAILED: the guard rejected %, which Intl and the form both accept (% %)', z, sqlstate, sqlerrm;
      failures := failures + 1;
    end;
  end loop;

  -- 7. A blank zone is refused too. `Intl` raises on '' exactly as it does on a
  --    typo, so an empty zone reaches the same silent UTC.
  --
  --    NULL is deliberately NOT tested here: `families.timezone` is NOT NULL
  --    with a default of 'UTC', so the column refuses it before any trigger
  --    runs. An earlier draft of this probe asserted a null write should
  --    succeed and failed against the real schema — the column's own
  --    constraint is the boundary there, not this one.
  begin
    update public.families set timezone = '   ' where id = fam;
    raise warning 'BREACH: a family was saved with a blank zone';
    failures := failures + 1;
  exception when others then null;
  end;

  -- 8. The guard covers INSERT too, not only UPDATE.
  begin
    insert into public.families (id, name, created_by, timezone)
      values ('00000000-0000-4000-8000-000000015002', 'Bad zone', pa_uid, 'Not/AZone');
    raise warning 'BREACH: a family was created with the unknown zone Not/AZone';
    failures := failures + 1;
    delete from public.families where id = '00000000-0000-4000-8000-000000015002';
  exception when others then null;
  end;

  update public.families set timezone = 'UTC' where id = fam;

  if failures > 0 then
    raise exception 'family-timezone-exists: % assertion(s) failed', failures;
  end if;
  raise notice 'family-timezone-exists: OK — a typo is refused and every zone the form offers still saves';
end
$probe$;
