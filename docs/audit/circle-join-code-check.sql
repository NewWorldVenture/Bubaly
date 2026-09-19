-- A join code a family reads aloud must be the code they can type back.
--
-- `marketplace_create_circle` promised "no 0/O/1/I" but ran `translate` BEFORE
-- `upper`, with only the uppercase letters in the from-set. base64 emits
-- lowercase too, so a lowercase `o` or `i` survived and `upper()` put the
-- ambiguity straight back. Measured before 0314: 4,568 of 20,000 codes — 22.8%
-- — carried an `O` or an `I`, while `0` and `1` never appeared at all. That
-- asymmetry is what makes it a dead end rather than a coin flip: a parent who
-- types the zero they think they see can never match anything.
--
-- Judged on what comes back, not on exceptions: a generator that stopped
-- excluding anything would still return a code, and a lookup that matched
-- nothing would still raise the same error it raises for a genuine typo.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  famA uuid := '00000000-0000-4000-8000-0000000c4a01';
  uA   uuid := '00000000-0000-4000-8000-0000000c4a0a';
  famB uuid := '00000000-0000-4000-8000-0000000c4b01';
  uB   uuid := '00000000-0000-4000-8000-0000000c4b0b';
  legacy uuid;
  got uuid;
  n int;
  codes text[];
  bad int;
  failures int := 0;
begin
  delete from public.marketplace_circle_members where family_id in (famA, famB);
  delete from public.marketplace_circles where created_by_family in (famA, famB) or join_code = 'OIVWXYZA';

  insert into auth.users (id, email) values
    (uA, 'circle-a@example.com'), (uB, 'circle-b@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (famA, 'Circle family A', uA), (famB, 'Circle family B', uB) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (famA, uA, 'Parent A', 'parent', true),
    (famB, uB, 'Parent B', 'parent', true) on conflict do nothing;

  -- A circle created before 0314, standing in for the 22.8% already out there.
  insert into public.marketplace_circles (name, emoji, join_code, created_by_family, created_by)
    values ('Legacy circle', '🤝', 'OIVWXYZA', famB, uB) returning id into legacy;
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
    values (legacy, famB, 'Circle family B', 'owner');

  -- ── 1. the generator ─────────────────────────────────────────────────────
  --
  -- Read straight out of the shipped function rather than re-deriving the
  -- expression here, so a probe cannot pass against a rule the database does
  -- not hold. 400 codes is enough: at the old 22.8% rate, the chance of seeing
  -- none is about 1 in 10^44.
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;

  codes := array(
    select public.marketplace_create_circle(famA, 'Probe circle ' || i)::text
    from generate_series(1, 400) i
  );
  reset role;
  select array_agg(c.join_code) into codes
    from public.marketplace_circles c where c.created_by_family = famA;

  select count(*) into bad from unnest(codes) code where code ~ '[0O1I]';
  if bad > 0 then
    raise warning 'BREACH: % of % generated join codes still carry 0, O, 1 or I (e.g. %)',
      bad, array_length(codes, 1), (select code from unnest(codes) code where code ~ '[0O1I]' limit 1);
    failures := failures + 1;
  end if;

  -- The premise the lookup normalisation rests on. If a stored code could ever
  -- contain a literal 0 or 1, reading a typed 0 as O would match the wrong
  -- circle. It cannot — asserted, not assumed.
  select count(*) into bad from public.marketplace_circles c where c.join_code ~ '[01]';
  if bad > 0 then
    raise warning 'BREACH: % stored join code(s) contain a literal 0 or 1, so normalising input is unsafe', bad;
    failures := failures + 1;
  end if;

  -- Positive control: the generator still produces usable codes.
  if array_length(codes, 1) <> 400 or exists (select 1 from unnest(codes) c where length(c) <> 8) then
    raise warning 'CONTROL FAILED: generator did not return 400 codes of 8 characters (got %)', array_length(codes, 1);
    failures := failures + 1;
  end if;
  if (select count(distinct c) from unnest(codes) c) <> 400 then
    raise warning 'CONTROL FAILED: generated codes collided';
    failures := failures + 1;
  end if;

  -- ── 2. the lookup ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;

  -- A parent typing the zero and the one they think they see on a legacy code.
  begin
    select public.marketplace_join_circle(famA, '0IVWXYZA') into got;
    if got is distinct from legacy then
      raise warning 'BREACH: typing 0 for O did not reach the circle (got %, wanted %)', got, legacy;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'BREACH: typing 0 for O was rejected outright (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  begin
    select public.marketplace_join_circle(famA, 'o1vwxyza') into got;   -- lower case, and a 1 for the I
    if got is distinct from legacy then
      raise warning 'BREACH: typing 1 for I did not reach the circle (got %, wanted %)', got, legacy;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'BREACH: typing 1 for I was rejected outright (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- Control: forgiving two characters must not make the lookup forgive
  -- everything. A code that is simply wrong is still wrong.
  begin
    perform public.marketplace_join_circle(famA, 'ZZZZZZZZ');
    raise warning 'CONTROL FAILED: an unknown code was accepted';
    failures := failures + 1;
  exception when others then null;
  end;

  -- Control: the membership guard still holds — famA's parent cannot join on
  -- behalf of famB, whatever the code says.
  begin
    perform public.marketplace_join_circle(famB, '0IVWXYZA');
    raise warning 'BREACH: a member of A joined a circle on behalf of B';
    failures := failures + 1;
  exception when others then null;
  end;

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.marketplace_circle_members where family_id in (famA, famB);
  delete from public.marketplace_circles where created_by_family in (famA, famB);

  if failures > 0 then
    raise exception '0314 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0314 OK: join codes exclude 0/O/1/I and legacy codes stay typeable (8 assertions)';
end
$probe$;
