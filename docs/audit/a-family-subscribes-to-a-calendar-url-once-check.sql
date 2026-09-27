-- ── A family subscribes to a calendar URL once (0386) ──────────────────────
--
-- HOLDS: supabase/migrations/0386_a_family_subscribes_to_a_calendar_url_once.sql
--
-- `public.calendar_feeds` (0045) had `url text NOT NULL` and nothing unique on
-- it. `addCalendarFeed` (app/(app)/dashboard/sync/feeds/actions.ts) now looks
-- for the family's existing row for a URL before inserting one — but a look is
-- only a look: two members pressing "Add & Sync Now" for the same school
-- calendar at the same moment both look, both find nothing, both insert, and
-- every event of that calendar then lands on the family calendar twice, once
-- under each feed_id (uq_calendar_events_feed_uid, 0285, is per feed). 0386
-- adds `uq_calendar_feeds_family_url` on (family_id, url) so the loser of that
-- race gets 23505, which the action catches, re-reads, and syncs the winner's
-- row. The vitest that shipped with the fix
-- (tests/a-calendar-that-failed-to-add-is-not-a-subscription.test.ts) runs
-- without a database and can only model that 23505; this file makes Postgres
-- say it, to the role the app's server client runs as.
--
-- Proves, as a member of the household (`authenticated`, auth.uid() set):
--
--   1. INSERT of a URL the family ALREADY subscribes to — the row another
--      member's add committed first — is refused with 23505, and the refusal
--      names uq_calendar_feeds_family_url (the index 0386 creates), not some
--      other key. Nothing is stored: the family still holds exactly one row
--      for that URL.
--   2. UPDATE of a feed's url onto a URL the family already holds is refused
--      the same way. No app path rewrites url today, but the FOR ALL member
--      policy lets PostgREST do it, and an index that only an INSERT met would
--      be a door left open beside the one 0386 closes.
--   3. `insert … on conflict (family_id, url) do nothing` is a legal statement
--      and skips the duplicate without an error — the arbiter is inferable,
--      which is 0386's WHY-NOT-PARTIAL claim, measured rather than read. A
--      partial index, or none, makes Postgres answer 42P10.
--   4. The SAME URL in a DIFFERENT family is a second, legitimate subscription
--      and lands: two households whose children go to one school each get the
--      school calendar. A key on `url` alone would pass 1–3 and break this.
--   5. The index in the catalog is unique, valid, non-partial, over exactly
--      (family_id, url) — so a later "fix" that swaps it for something looser
--      under the same name goes red here, not in a family's calendar.
--
-- NEGATIVE CONTROL, and it runs FIRST
-- ---------------------------------------------------------------------------
-- The guard keys on (family_id, url). The control is the SAME member, in the
-- SAME family, through the SAME statements with the SAME column lists — an
-- INSERT of (id, family_id, name, url, color, created_by), then an UPDATE
-- that SETs url on that very row — with the one thing the guard keys on
-- flipped: a URL this family does NOT yet subscribe to. Both MUST land, one
-- row each. Only then are the refusals below read at all.
--
-- What it catches. Refusal 1 and 2 look for 23505 by constraint name, which is
-- sharper than a bare "something said no" — but the control is still what
-- lets a pass mean anything:
--   * a revoked INSERT/UPDATE grant, a column-level revoke on `url`, or a
--     dead auth.uid() (so is_family_member() says no and the policy refuses)
--     would make this member's session unable to write calendar_feeds at all.
--     Refusal 2 would then report zero rows or 42501 and the refusal of a
--     duplicate would be unmeasurable; the control goes red and says so.
--   * an unrelated BEFORE INSERT/UPDATE trigger that raises (the way 0223,
--     0305, 0326 and 0331 refuse writes in this repo) is refused on the
--     control too, instead of passing off its refusal as the index's.
--   * a session that cannot SEE the row it updates (the classic zero-row
--     "refusal" that is really invisibility) fails the control's row count.
-- A failed control does not report the boundary as holding or as broken: it
-- raises "UNPROVEN" with the reason, and the build is red either way.
--
-- The row another member's add committed first is seeded as `postgres`, not
-- inserted through this member's session, so that a broken write path fails
-- on the CONTROL — the first write this session makes — rather than on the
-- fixture.
--
-- Everything is inside one transaction and rolled back; a re-run starts clean.
-- Every UUID below is unique across docs/audit and supabase/migrations
-- (prefix 0386ca1e-…-8363-), because run-probes.sh runs every probe against
-- one database.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-family-subscribes-to-a-calendar-url-once-check.sql

-- The member acting throughout: in the household that already subscribes (FA)
-- and in a second household of their own (FB).
\set UA '0386ca1e-0000-4000-8363-000000000001'
-- The other member of FA, whose add of the school calendar won the race.
\set UB '0386ca1e-0000-4000-8363-000000000002'
\set FA '0386ca1e-0000-4000-8363-000000000011'
\set FB '0386ca1e-0000-4000-8363-000000000012'
\set MB '0386ca1e-0000-4000-8363-000000000022'
-- The subscription UB's add committed: (FA, school URL).
\set WIN '0386ca1e-0000-4000-8363-000000000031'

begin;

insert into auth.users (id, email) values (:'UA','cal0386-member@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UB','cal0386-winner@example.com')  on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA','Calendar Once House',:'UA') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FB','Calendar Once Second House',:'UA') on conflict do nothing;
-- on_family_created files the creator as a member already; upsert rather than
-- assume, because a seed whose memberships are wrong would fail the control
-- for a reason that is not the control's.
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA',:'UA','Member','parent',true)
  on conflict (family_id, user_id) do update set is_active = true;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FB',:'UA','Member (own house)','parent',true)
  on conflict (family_id, user_id) do update set is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MB',:'FA',:'UB','Winner','parent',true)
  on conflict (family_id, user_id) do update set is_active = true;

-- What the race's winner left behind: FA already subscribes to the school
-- calendar. Seeded as postgres (see the header).
insert into public.calendar_feeds (id, family_id, name, url, color, created_by)
  values (:'WIN',:'FA','School','https://school.example.org/0386/calendar.ics','blue',:'UB');

do $$
declare
  n int;
  cname text;
  failures text[] := '{}';
  control_ok boolean := true;
  member_u   constant uuid := '0386ca1e-0000-4000-8363-000000000001';
  fam_a      constant uuid := '0386ca1e-0000-4000-8363-000000000011';
  fam_b      constant uuid := '0386ca1e-0000-4000-8363-000000000012';
  ctl_row    constant uuid := '0386ca1e-0000-4000-8363-000000000032';
  other_fam_row constant uuid := '0386ca1e-0000-4000-8363-000000000033';
  dup_row    constant uuid := '0386ca1e-0000-4000-8363-000000000034';
  upsert_row constant uuid := '0386ca1e-0000-4000-8363-000000000035';
  -- The URL FA already holds, and two it does not.
  url_school constant text := 'https://school.example.org/0386/calendar.ics';
  url_sports constant text := 'https://league.example.org/0386/fixtures.ics';
  url_choir  constant text := 'https://choir.example.org/0386/rehearsals.ics';
begin
  -- ── As a member of FA (same as `set local role authenticated`) ─────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', member_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── NEGATIVE CONTROL: same member, same family, same statements, same ──
  -- ── columns — a URL the family does NOT yet subscribe to ──────────────
  begin
    insert into public.calendar_feeds (id, family_id, name, url, color, created_by)
      values (ctl_row, fam_a, 'Sports', url_sports, 'blue', member_u);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: this member''s INSERT of a calendar URL their family does NOT hold stored %s rows, so a refused duplicate below would prove nothing about uq_calendar_feeds_family_url', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: this member was refused a calendar URL their family does NOT hold (%s: %s), so a refusal below would prove only that something said no — not that 0386''s index did', sqlstate, sqlerrm));
  end;

  if control_ok then
    begin
      -- The same column refusal 2 writes (`url`), on the same row it writes,
      -- to a URL no row of FA holds.
      update public.calendar_feeds set url = url_choir where id = ctl_row;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: this member''s UPDATE of url on their own family''s feed, to a URL the family does NOT hold, changed %s rows — a row this session cannot see or write reports the same as a refusal, so refusal 2 below would prove nothing', n));
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: this member''s UPDATE of url on their own family''s feed, to a URL the family does NOT hold, raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if not control_ok then
    raise exception 'calendar-URL-once boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  -- ── 1. The race's loser: INSERT the URL the family already holds ──────
  begin
    insert into public.calendar_feeds (id, family_id, name, url, color, created_by)
      values (dup_row, fam_a, 'School (again)', url_school, 'blue', member_u);
    get diagnostics n = row_count;
    failures := array_append(failures, format('a member subscribed their family to %s a SECOND time (%s row stored) — every event of that calendar would import once per row', url_school, n));
  exception
    when unique_violation then
      get stacked diagnostics cname = constraint_name;
      if cname is distinct from 'uq_calendar_feeds_family_url' then
        failures := array_append(failures, format('the duplicate subscription was refused by %s, not by uq_calendar_feeds_family_url — the key addCalendarFeed''s 23505 branch is written for', coalesce(cname, '(no constraint name)')));
      end if;
    when others then
      failures := array_append(failures, format('the duplicate subscription raised %s: %s — not the 23505 addCalendarFeed catches and re-reads', sqlstate, sqlerrm));
  end;

  -- ── 2. UPDATE a feed's url onto one the family already holds ──────────
  begin
    update public.calendar_feeds set url = url_school where id = ctl_row;
    get diagnostics n = row_count;
    failures := array_append(failures, format('a member re-pointed a feed''s url at %s, which their family already subscribes to (%s row changed) — the duplicate arrives by UPDATE instead', url_school, n));
  exception
    when unique_violation then
      get stacked diagnostics cname = constraint_name;
      if cname is distinct from 'uq_calendar_feeds_family_url' then
        failures := array_append(failures, format('the url UPDATE onto a held URL was refused by %s, not by uq_calendar_feeds_family_url', coalesce(cname, '(no constraint name)')));
      end if;
    when others then
      failures := array_append(failures, format('the url UPDATE onto a held URL raised %s: %s, not 23505', sqlstate, sqlerrm));
  end;

  -- ── 3. The arbiter is inferable: ON CONFLICT (family_id, url) ─────────
  begin
    insert into public.calendar_feeds (id, family_id, name, url, color, created_by)
      values (upsert_row, fam_a, 'School (upsert)', url_school, 'blue', member_u)
      on conflict (family_id, url) do nothing;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('insert … on conflict (family_id, url) do nothing STORED %s row for a URL the family already holds', n));
    end if;
  exception when others then
    failures := array_append(failures, format('insert … on conflict (family_id, url) do nothing raised %s: %s — no non-partial unique index over (family_id, url) for Postgres to infer', sqlstate, sqlerrm));
  end;

  -- ── 4. Per family, not per URL: another household may hold it too ─────
  begin
    insert into public.calendar_feeds (id, family_id, name, url, color, created_by)
      values (other_fam_row, fam_b, 'School', url_school, 'blue', member_u);
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('the same school calendar in a DIFFERENT family stored %s rows — it is a separate, legitimate subscription', n));
    end if;
  exception when others then
    failures := array_append(failures, format('the same school calendar in a DIFFERENT family was refused (%s: %s) — the key must be (family_id, url), not url alone', sqlstate, sqlerrm));
  end;

  -- ── Back to postgres: count what is stored, read the catalog ──────────
  perform set_config('role','postgres', true);

  select count(*) into n from public.calendar_feeds where family_id = fam_a and url = url_school;
  if n <> 1 then
    failures := array_append(failures, format('family A holds %s rows for %s after the refusals; it must hold exactly the one the first add committed', n, url_school));
  end if;

  select count(*) into n
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace ns on ns.oid = ic.relnamespace
   where i.indrelid = 'public.calendar_feeds'::regclass
     and ns.nspname = 'public'
     and ic.relname = 'uq_calendar_feeds_family_url'
     and i.indisunique and i.indisvalid and i.indisready
     and i.indpred is null and i.indexprs is null
     and i.indnatts = 2
     and (select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
         = array['family_id','url'];
  if n <> 1 then
    failures := array_append(failures, 'public.uq_calendar_feeds_family_url is not a valid, non-partial unique index over exactly (family_id, url) — apply supabase/migrations/0386_a_family_subscribes_to_a_calendar_url_once.sql');
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'calendar-URL-once boundary failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK calendar_feeds: the same member CAN add and re-point a calendar URL their family does not hold (control); a second subscription to a URL the family holds is refused with 23505 on uq_calendar_feeds_family_url, by INSERT and by UPDATE, and nothing is stored';
  raise notice 'OK calendar_feeds: on conflict (family_id, url) is inferable, another family may subscribe to the same URL, and the index is unique, valid and non-partial over (family_id, url)';
end $$;

rollback;
