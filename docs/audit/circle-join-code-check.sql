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
--
-- NEGATIVE CONTROL, and it runs FIRST, before the two scans it underwrites
-- ---------------------------------------------------------------------------
-- MECHANISM. This boundary is not RLS. `join_code` carries no CHECK constraint
-- and no guard trigger — 0176 declares it `join_code text not null unique` and
-- nothing after it alters the column — so the only thing that keeps a `0` or a
-- `1` out of a stored code is one expression inside one SECURITY DEFINER
-- plpgsql function: the `translate(..., '0O1Iloi+/=', 'ABCDEJKFGH')` in
-- `public.marketplace_create_circle`. `0314_circle_join_codes_are_unambiguous`
-- is the LAST migration to create that function and the matching
-- `marketplace_join_circle` (`grep -l` across supabase/migrations returns only
-- 0176 and 0314; 0321 adds an index and touches neither body). So 0314 governs,
-- and the probe's two halves are the function's two halves.
--
-- WHAT HAD NO ATTRIBUTION. The generator half re-reads its 400 codes out of the
-- table and the existing positive control makes it say 400-of-8-characters, so
-- that half speaks for itself. The second assertion does not:
--
--     select count(*) into bad from public.marketplace_circles c
--       where c.join_code ~ '[01]';
--
-- That is an un-narrowed scan asserting ZERO ROWS, and it is the premise the
-- whole lookup half rests on — 0314 forgives a typed `0` as `O` and a typed `1`
-- as `I` and calls that "unconditionally safe" precisely because no stored code
-- can contain a digit. A row this session cannot SEE returns zero just as
-- readily as a corpus that genuinely holds none, and the vacuity is not
-- hypothetical here: `marketplace_circles` has RLS enabled (0176) and its
-- SELECT policy `mkt_circles_select` is `public.is_marketplace_circle_member(id)`
-- (re-created by 0178, the last migration to touch it). Run this probe as
-- anything but an RLS-exempt role — a non-owner PGUSER, or an owner once anyone
-- adds `force row level security` — and that scan sees only circles the caller's
-- own family has joined, which at that point is none. `bad` comes back 0, the
-- probe goes green, and the sentence it printed ("no stored join code contains a
-- literal 0 or 1") was never measured against a single row. A missing table
-- GRANT is NOT this failure mode: that raises 42501 and ON_ERROR_STOP turns it
-- red. Silent blindness is the one that passes.
--
-- THE CONTROL. The same actor — the same base role, mid-block, before any
-- `set local role` — running the same statement against the same table and the
-- SAME COLUMN through the same `~` operator, with the one thing the scan keys on
-- changed and the answer the other way: the two digits swapped for the two
-- letters they are confused with. `[OI]` must LAND. Naming the same column is
-- load-bearing for the same reason the child_logins control repoints `user_id`:
-- a control that proved visibility of some other column, or counted the table
-- without a regex, would sail past exactly the blindness that kills the real
-- scan. And the row it must reach is the legacy circle planted below, which
-- belongs to famB — a circle this session is a member of NO family in — so the
-- control also proves the scan reaches outside the caller's own circle scope,
-- which is the only way a claim about the whole 22.8% population can be made.
--
-- If the `[01]` zero came from the generator, this control lands. If it came
-- from RLS filtering the scan to nothing, this control comes back zero too, and
-- the probe goes red — which is what you want, because its attribution was
-- wrong. The control cannot fail on a healthy run: this probe already requires
-- an RLS-exempt role to insert into `auth.users` and to `set local role` at all.
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

  -- ── 0. NEGATIVE CONTROL: the same scan, the other two characters ─────────
  --
  -- Runs FIRST — as early as its own premise allows, which is the line after
  -- the legacy circle exists — and in the same role the scan it controls runs
  -- in: the base role, no `set local role` yet, RLS-exempt or this probe could
  -- not have reached `auth.users` above. Seeds nothing of its own; the legacy
  -- row IS the row with the answer the other way.
  --
  -- The first statement is the `[01]` assertion below token for token, with
  -- only the two characters in the class swapped for the two they are confused
  -- with. It must find rows. The second pins WHICH row, because "saw something
  -- ambiguous" is weaker than "saw the one we planted in a circle this session
  -- belongs to no family in" — that second reading is what licenses the
  -- un-narrowed scan to speak for codes outside the caller's own scope.
  --
  -- Catches: `mkt_circles_select` (0178) filtering the scan to nothing under a
  -- non-exempt role or a future `force row level security`; a `join_code`
  -- rendered unscannable by `~`; and, one step on, the read-back of famA's
  -- codes returning NULL — `array_length(NULL, 1) <> 400` is NULL, so that
  -- positive control's `if` would not even fire.
  select count(*) into n from public.marketplace_circles c where c.join_code ~ '[OI]';
  select count(*) into bad from public.marketplace_circles c
    where c.join_code ~ '[OI]' and c.join_code = 'OIVWXYZA';

  if n = 0 then
    raise warning 'CONTROL FAILED: the un-narrowed scan of marketplace_circles.join_code cannot see a single code carrying an O or an I, so the identical scan for a literal 0 or 1 returning zero proves nothing — it is blindness, not a clean corpus, and the lookup normalisation premise is UNPROVEN';
    failures := failures + 1;
  elsif bad <> 1 then
    raise warning 'CONTROL FAILED: the scan sees % ambiguous code(s) but not the legacy OIVWXYZA planted in famB''s circle, so it does not reach rows outside this session''s own circle scope and cannot speak for the 22.8%% population the 0/1 assertion is about', n;
    failures := failures + 1;
  end if;

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
  raise notice '0314 OK: the same scan CAN see an O/I-bearing code outside this session''s circle scope (control), and with that attribution join codes exclude 0/O/1/I and legacy codes stay typeable (10 assertions)';
end
$probe$;
