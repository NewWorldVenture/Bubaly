-- ── One person, one vote, for a member of two families ─────────────────────
--
-- family_poll_votes, meal_vote_ballots, watchlist_votes and event_rsvps write
-- with is_family_member(family_id) and is_self_member(member_id), and
-- is_self_member is not bound to a family. Each is unique per (option,
-- member), and every tally reads its own family's rows, so a person active in
-- two families (here a child of Mom's house and Dad's house) voted a second
-- time in Mom's house under their Dad's-house member id. The held 0501 wires
-- 0311's reference_shares_family('member_id', 'family_members') onto all four.
--
-- What this probe asserts, as that child through PostgREST's role, for each of
-- the four tables:
--
--   1. control: their vote in Mom's house as their Mom's-house member lands;
--   2. the same vote again under their Dad's-house member id is refused BY THE
--      GUARD (42501, reference_shares_family's own sentence), and Mom's house
--      still holds exactly one of their votes;
--   3. UPDATE of their own vote's member_id to the Dad's-house member is
--      refused by the guard, and the vote is unchanged;
--   4. UPDATE of their own vote's family_id to Dad's house is refused by the
--      guard;
--
-- and, once for the class:
--
--   5. control: the same child still votes once in Dad's own poll, as their
--      Dad's-house member (one vote in each household);
--   6. control: the service role and a session-less writer are exempt;
--   7. each of the four is wired to 0311's helper, exactly;
--   8. NEGATIVE CONTROL: with the poll-vote trigger disabled inside the
--      transaction, the second vote lands. That proves the fixture reaches the
--      defect.
--
-- Everything is rolled back.
--
-- HELD with 0501: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/one-member-one-vote-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0501 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8501-0000000000a1','v0501-mom@example.com'),
  ('00000000-0000-4000-8501-0000000000b1','v0501-dad@example.com'),
  ('00000000-0000-4000-8501-0000000000a4','v0501-kid@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8501-0000000000f1','Mom''s house','00000000-0000-4000-8501-0000000000a1'),
  ('00000000-0000-4000-8501-0000000000f2','Dad''s house','00000000-0000-4000-8501-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8501-0000000000a1','00000000-0000-4000-8501-0000000000b1');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8501-0000000000c1','00000000-0000-4000-8501-0000000000f1','00000000-0000-4000-8501-0000000000a4','Kid','child',true),
  ('00000000-0000-4000-8501-0000000000c2','00000000-0000-4000-8501-0000000000f2','00000000-0000-4000-8501-0000000000a4','Kid','child',true);
-- Mom's house: a poll, a dinner vote, a title, an event.
insert into public.family_polls (id, family_id, question, kind, status) values
  ('00000000-0000-4000-8501-0000000000d1','00000000-0000-4000-8501-0000000000f1','Beach or mountains?','single','open'),
  ('00000000-0000-4000-8501-0000000000d9','00000000-0000-4000-8501-0000000000f2','Pizza or tacos?','single','open');
insert into public.family_poll_options (id, family_id, poll_id, label, sort) values
  ('00000000-0000-4000-8501-0000000000e1','00000000-0000-4000-8501-0000000000f1','00000000-0000-4000-8501-0000000000d1','Beach',0),
  ('00000000-0000-4000-8501-0000000000e9','00000000-0000-4000-8501-0000000000f2','00000000-0000-4000-8501-0000000000d9','Pizza',0);
insert into public.meal_votes (id, family_id, title, status) values
  ('00000000-0000-4000-8501-0000000000d3','00000000-0000-4000-8501-0000000000f1','Dinner','open');
insert into public.meal_vote_options (id, vote_id, family_id, label) values
  ('00000000-0000-4000-8501-0000000000e3','00000000-0000-4000-8501-0000000000d3','00000000-0000-4000-8501-0000000000f1','Pizza');
insert into public.watchlist_titles (id, family_id, title, kind, service) values
  ('00000000-0000-4000-8501-0000000000d2','00000000-0000-4000-8501-0000000000f1','Movie','movie','other');
insert into public.calendar_events (id, family_id, title, category, starts_at) values
  ('00000000-0000-4000-8501-0000000000d4','00000000-0000-4000-8501-0000000000f1','Party','other', now());

do $$
declare
  mom      constant uuid := '00000000-0000-4000-8501-0000000000f1';
  dad      constant uuid := '00000000-0000-4000-8501-0000000000f2';
  at_mom   constant uuid := '00000000-0000-4000-8501-0000000000c1';
  at_dad   constant uuid := '00000000-0000-4000-8501-0000000000c2';
  guard    constant text := '42501: % points at a row in another family';
  failures text[] := '{}';
  t        record;
  got      text;
  n        int;
  own_id   uuid;
begin
  for t in select * from (values
      ('family_poll_votes', 'a poll vote',
       'insert into public.family_poll_votes (family_id, poll_id, option_id, member_id) values (%L, ''00000000-0000-4000-8501-0000000000d1'', ''00000000-0000-4000-8501-0000000000e1'', %L) returning id',
       'option_id = ''00000000-0000-4000-8501-0000000000e1'''),
      ('meal_vote_ballots', 'a dinner ballot',
       'insert into public.meal_vote_ballots (vote_id, option_id, family_id, member_id, choice) values (''00000000-0000-4000-8501-0000000000d3'', ''00000000-0000-4000-8501-0000000000e3'', %L, %L, ''yes'') returning id',
       'option_id = ''00000000-0000-4000-8501-0000000000e3'''),
      ('watchlist_votes', 'a watchlist vote',
       'insert into public.watchlist_votes (family_id, title_id, member_id, vote) values (%L, ''00000000-0000-4000-8501-0000000000d2'', %L, ''love'') returning id',
       'title_id = ''00000000-0000-4000-8501-0000000000d2'''),
      ('event_rsvps', 'an RSVP',
       'insert into public.event_rsvps (event_id, family_id, member_id, status) values (''00000000-0000-4000-8501-0000000000d4'', %L, %L, ''accepted'') returning id',
       'event_id = ''00000000-0000-4000-8501-0000000000d4''')
    ) as v(tbl, what, ins, target) loop

    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8501-0000000000a4', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8501-0000000000a4','role','authenticated')::text, true);

    -- 1. Their own vote in Mom's house.
    own_id := null;
    begin
      execute format(t.ins, mom, at_mom) into own_id;
    exception when others then
      failures := array_append(failures, format('CONTROL: the child could not cast %s in Mom''s house as their own member there (%s: %s)', t.what, sqlstate, sqlerrm));
    end;

    -- 2. The same vote again, under the Dad's-house member id.
    begin
      execute format(t.ins, mom, at_dad);
      got := 'landed';
      raise exception using errcode = 'P0R01';
    exception
      when sqlstate 'P0R01' then null;
      when others then got := sqlstate || ': ' || sqlerrm;
    end;
    if got = 'landed' then
      failures := array_append(failures, format('%s: the child cast %s a second time in Mom''s house under their Dad''s-house member', t.tbl, t.what));
    elsif got not like guard then
      failures := array_append(failures, format('%s: the second vote was refused, but not by the guard (%s)', t.tbl, got));
    end if;

    -- 3. Re-pointing their own vote at the Dad's-house member.
    if own_id is not null then
      begin
        execute format('update public.%I set member_id = %L where id = %L', t.tbl, at_dad, own_id);
        get diagnostics n = row_count;
        got := format('%s row(s)', n);
        raise exception using errcode = 'P0R01';
      exception
        when sqlstate 'P0R01' then null;
        when others then got := sqlstate || ': ' || sqlerrm;
      end;
      if got not like guard then
        failures := array_append(failures, format('%s: the child moved their own vote onto their Dad''s-house member (%s)', t.tbl, got));
      end if;
      -- 4. Moving it into Dad's house.
      begin
        execute format('update public.%I set family_id = %L where id = %L', t.tbl, dad, own_id);
        get diagnostics n = row_count;
        got := format('%s row(s)', n);
        raise exception using errcode = 'P0R01';
      exception
        when sqlstate 'P0R01' then null;
        when others then got := sqlstate || ': ' || sqlerrm;
      end;
      if got not like guard then
        failures := array_append(failures, format('%s: the child moved their own vote into Dad''s house (%s)', t.tbl, got));
      end if;
    end if;

    perform set_config('role','postgres', true);
    execute format('select count(*) from public.%I where family_id = %L and %s', t.tbl, mom, t.target) into n;
    if n <> 1 then
      failures := array_append(failures, format('%s: Mom''s house holds %s of this child''s votes, not 1', t.tbl, n));
    end if;
  end loop;

  -- 5. One vote in each household.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8501-0000000000a4', true);
  perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8501-0000000000a4','role','authenticated')::text, true);
  begin
    insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
      values (dad, '00000000-0000-4000-8501-0000000000d9', '00000000-0000-4000-8501-0000000000e9', at_dad);
  exception when others then
    failures := array_append(failures, format('CONTROL: the child could not vote in Dad''s own poll as their member there (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 6. The service role and a session-less writer are exempt.
  begin
    perform set_config('role','service_role', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', json_build_object('role','service_role')::text, true);
    insert into public.event_rsvps (event_id, family_id, member_id, status)
      values ('00000000-0000-4000-8501-0000000000d4', mom, at_dad, 'maybe');
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the service role was refused (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    perform set_config('role','postgres', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    insert into public.event_rsvps (event_id, family_id, member_id, status)
      values ('00000000-0000-4000-8501-0000000000d4', mom, at_dad, 'maybe');
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: a session-less writer was refused (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 7. Wiring.
  select count(*) into n
    from pg_trigger tr
   where tr.tgfoid = 'public.reference_shares_family()'::regprocedure
     and tr.tgenabled <> 'D'
     and (tr.tgrelid, encode(tr.tgargs, 'escape')) in (
       ('public.family_poll_votes'::regclass, E'member_id\\000family_members\\000'),
       ('public.meal_vote_ballots'::regclass, E'member_id\\000family_members\\000'),
       ('public.watchlist_votes'::regclass,   E'member_id\\000family_members\\000'),
       ('public.event_rsvps'::regclass,       E'member_id\\000family_members\\000'));
  if n <> 4 then
    failures := array_append(failures, format('%s of the 4 vote tables run reference_shares_family on member_id', n));
  end if;

  -- 8. NEGATIVE CONTROL: without the poll-vote trigger, the second vote lands.
  if exists (select 1 from pg_trigger where tgrelid = 'public.family_poll_votes'::regclass
                and tgname = 'trg_family_poll_votes_member_id_family') then
    begin
      alter table public.family_poll_votes disable trigger trg_family_poll_votes_member_id_family;
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8501-0000000000a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8501-0000000000a4','role','authenticated')::text, true);
      begin
        insert into public.family_poll_votes (family_id, poll_id, option_id, member_id)
          values (mom, '00000000-0000-4000-8501-0000000000d1', '00000000-0000-4000-8501-0000000000e1', at_dad);
        got := 'landed';
      exception when others then got := sqlstate || ': ' || sqlerrm;
      end;
      perform set_config('role','postgres', true);
      if got is distinct from 'landed' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the second vote still did not land (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    perform set_config('role','postgres', true);
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a member of two families votes twice:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'one-member-one-vote-in-two-households: OK (as a child of two households, in Mom''s house: a poll vote, a dinner ballot, a watchlist vote and an RSVP each landed once as their member there; the same again under their Dad''s-house member, re-pointing their own vote at it, and moving their own vote into Dad''s house were each refused by reference_shares_family (42501, its own sentence), and Mom''s house holds one of each; they still vote in Dad''s own poll as their member there; the service role and a session-less writer are exempt; all four tables run the guard; negative control: with the poll-vote guard disabled the second vote landed)';
end $$;

rollback;
