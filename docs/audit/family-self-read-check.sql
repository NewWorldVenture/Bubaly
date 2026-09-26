-- ── A family can still read its own rows ────────────────────────────────────
-- The other half of the 0118 failure, and the half no probe covered.
--
-- `0118` exists because production tables had RLS ENABLED with their family
-- policies MISSING, so pages silently returned zero rows. Every existing probe
-- looks for a leak — can family B read family A? — and a missing SELECT policy
-- passes all of them, because default-deny is exactly what they assert. Drop
-- `calendar_events_select` tomorrow and the isolation probe stays green while a
-- family's calendar goes blank.
--
-- So this asserts the opposite direction, across EVERY family-scoped table at
-- once rather than a hand-kept list: for each table where the owner can see
-- anchor-family rows, the anchor family's own parent must see them too. A table
-- the seed leaves empty is skipped and counted — it cannot demonstrate anything
-- either way, and saying so is better than quietly including it in the total.
--
-- One case is not a failure of this rule but its deliberate opposite: a table
-- carrying a RESTRICTIVE deny-all policy for PUBLIC over every command is shut
-- to every non-bypassing role BY CONSTRUCTION. `0262` does exactly that to
-- `home_briefs`, and says why — a saved snapshot cannot revalidate access to
-- each of its sources, so persisted access is denied until an authorization and
-- invalidation contract exists. Demanding that a family read those rows would
-- be demanding the quarantine be broken. Such a table is therefore checked the
-- other way round: it must be closed, and the probe fails if it is OPEN. That
-- keeps the skip honest — lift the quarantine without adding the contract and
-- the table falls back under the ordinary rule on the next run.
--
-- The condition is read from the catalog, not from a list of table names, so
-- the next quarantine needs no edit here. (Until `0285` fixed the ON CONFLICT
-- target in `SEED_ALL.sql`, `home_briefs` seeded nothing and was skipped as
-- empty, so none of this was reachable.)
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/family-self-read-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.
--
-- The anchor family and its parent are pg-bootstrap.sh's ANCHOR_FID and
-- ANCHOR_UID defaults, `…-0000000000f1` and `…-000000000001`. They appear as
-- literals inside the two blocks below, not as psql variables, because psql
-- does not interpolate `:var` inside a dollar-quoted body — a `\set` here would
-- be decoration that looks like a parameter and drifts like one.

-- ── NEGATIVE CONTROL FOR THE QUARANTINE VERDICT, and it runs FIRST ───────────
--
-- Of this probe's two verdicts only one is refusal-shaped, and only that one
-- needs a control. The SELF-READ rule fails when a read does NOT land, so its
-- green is a landing and cannot be faked: rows do not become visible by
-- accident. The QUARANTINE rule is the inverted one — for a table carrying a
-- RESTRICTIVE deny-all it passes on ZERO ROWS and credits that zero to the
-- deny-all. That is the sentence with no attribution, and it is the same defect
-- as an UPDATE that asserts zero rows: a session that can see nothing at all
-- reads zero just as readily as a quarantine does.
--
-- Worse, the loop below actively launders the two cheapest wrong explanations.
-- `member_rows := -1` on `insufficient_privilege` is labelled "no grant at all:
-- also blind, and worth naming as such" — true on the ordinary path, where -1
-- fails. On the quarantine path -1 falls into `member_rows <= 0` and is counted
-- as "deliberately quarantined and verified closed". So `revoke select on
-- home_briefs from authenticated` — or that revoke followed by a column-level
-- re-grant that leaves `family_id` out — and this probe reports a quarantine it
-- never touched: a 42501 from the GRANT layer credited to a policy, which is the
-- first failure mode in the audit's own list. Drop the table's permissive SELECT
-- policy instead and the read returns a plain zero by default-deny, and the same
-- green appears.
--
-- MECHANISM, and how I know which one. RLS, specifically ONE restrictive policy:
-- `home_briefs_snapshot_quarantine`, `as restrictive for all to public using
-- (false) with check (false)`, created in `0262_home_briefs_quarantine.sql`.
-- 0262 is the LAST word on it, not merely the first: it is the only file in
-- supabase/migrations that names that policy at all, and the only one in the
-- corpus that creates a restrictive policy which is not a per-command write
-- guard `to authenticated` — which is also exactly what makes the loop's `sealed`
-- shape test (restrictive + polcmd '*' + polroles {0}) select this table and
-- nothing else. 0262 only ADDED that policy; 0140's permissive
-- `home_briefs_select using (public.is_family_member(family_id))` still stands
-- (0258 and 0261 touch columns and a unique index, and 0264 says in writing that
-- it leaves this table to 0262). So the observed zero is the AND of a permissive
-- predicate that should answer yes and a restrictive constant that answers no,
-- and the whole question is which half is doing the refusing.
--
-- WHY THE CONTROL IS SHAPED THIS WAY. `using (false)` takes no argument, and
-- `to public` covers every non-bypassing role, so no row value and no actor this
-- probe is allowed to be can make THAT predicate answer the other way — the
-- usual "same row, other scope" control does not exist here. The one thing the
-- mechanism keys on is therefore the table, and the control is the same actor
-- running the same statement through the SAME permissive predicate on a table
-- that does not carry the quarantine, which MUST LAND. Same-predicate is
-- verified, not assumed, and it is the whole SET that is matched: the twin is
-- chosen from the catalog by comparing `pg_get_expr(polqual)` of EVERY
-- permissive SELECT-covering policy reaching `authenticated` against the sealed
-- table's own set. Permissive policies compose with OR, so a twin that carried
-- the right predicate plus a broader one (`using (true)` reads exist in this
-- schema — 0139, 0219) would land while `is_family_member` answered false; and a
-- sealed table with two permissive predicates is compared as two, not as
-- whichever sorts first. The twin must also have RLS ENABLED — with it off every
-- row lands whatever the actor can see, and the control's green would be the
-- same vacuous green it exists to remove, one level up — and must be free of any
-- restrictive policy covering SELECT, so that a failure to land cannot be some
-- other guard's doing. On this database the twin resolves to a family table
-- whose only permissive read predicate is `is_family_member(family_id)` — the
-- anchor family always has at least `family_members` (whose sole read policy,
-- `fm_select`, is exactly that), because pg-bootstrap.sh creates FA with
-- `created_by = UA` and `handle_new_family` files UA as an active parent.
--
-- What the control catches, that the verdict alone cannot: a dead `auth.uid()`
-- (the shim reads `request.jwt.claim.sub`), a role switch that did not take, UA
-- not actually being an active member of FA, and SELECT revoked from
-- `authenticated` schema-wide. Each of those closes home_briefs on its own, and
-- with any of them in force the quarantine could have been rewritten to
-- `using (true)` — the very loosening the loop's shape test exists to survive —
-- and the probe would still have printed "verified closed".
--
-- The escape a cross-table read cannot see is checked against the sealed table
-- itself, for the actor the verdict uses: `has_column_privilege` on `family_id`
-- — the analogue of the child_logins control naming the same COLUMNS as the
-- write under test. `family_id` is the only column the statement under test
-- reads, so SELECT on it is exactly the privilege that statement needs: a
-- table-level SELECT implies it, a column-level SELECT supplies it on its own,
-- and when neither exists the read raises 42501 and the verdict records -1,
-- silently "closed". It is ONE test, not a table-level test followed by a
-- column-level one, because Postgres derives column privileges from table
-- privileges: once `has_table_privilege(…, 'SELECT')` is true every column's
-- `has_column_privilege` is true by construction, and `revoke select
-- (family_id)` on top of a table-level grant subtracts nothing — verified on
-- this database: after it the read still lands. A second test would be dead
-- code, and the column-revoke story it would tell is not a real laundering
-- path. The real one is a table-level revoke plus a column-restricted re-grant
-- that omits `family_id`, and the single test catches exactly that.
--
-- RLS itself is asserted on both sides. 0262 enables it on the sealed table in
-- the same block that creates the quarantine; a deny-all policy on a table with
-- RLS off is inert, and a control that vouches for a quarantine must first
-- establish that the quarantine is in force. (That state cannot manufacture a
-- zero — with RLS off the read lands and the verdict below would go red on its
-- own — but "red for the right reason" is the point of a control.)
--
-- THE ONE JUDGEMENT CALL, stated so it can be argued with: a sealed table that
-- has NO permissive SELECT policy, or no grant, is not a broken schema — it is
-- shut twice over, which is stronger. But it is a table whose closure this probe
-- can no longer attribute to the quarantine, and whose quarantine could be
-- lifted with nothing here noticing. So that case is reported as UNPROVEN, not
-- as a leak: if a later migration hardens the quarantine that way on purpose,
-- this line goes red on purpose, and the decision and this probe get revisited
-- together — the same contract the child_logins probe writes down for a child's
-- read staying open.
--
-- It seeds NOTHING and invents no UUID. run-probes.sh runs every
-- docs/audit/*-check.sql against one database in sequence and this file has no
-- transaction wrapper, so anything
-- seeded here would outlive it; the control needs only rows the anchor bootstrap
-- already guarantees, and adds no row another probe could count.
--
-- It raises before the loop runs, like the child_logins control does, because a
-- session that cannot see its own family's rows makes "the anchor family cannot
-- read its own rows" an actively wrong diagnosis — that is a broken actor, not a
-- broken policy, and the probe should say which.
do $control$
declare
  s            record;
  cand         record;
  seal_oid     oid;
  seal_rows    int;
  preds        text[];
  pred_txt     text;
  twin_tbl     text;
  twin_rows    int;
  cand_rows    int;
  landed       int;
  sealed_total int := 0;
  sealed_seen  int := 0;
  notes        text[] := '{}';
  proved       text[] := '{}';
begin
  -- The same `sealed` shape the verdict uses, quoted rather than re-invented, so
  -- the control and the branch it underwrites can never disagree about which
  -- tables are in scope.
  for s in
    select c.relname as tbl, c.oid as reloid, c.relrowsecurity as rls_on
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join information_schema.columns col
      on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'family_id'
    where ns.nspname = 'public' and c.relkind = 'r'
      and exists (
        select 1
        from pg_catalog.pg_policy p
        where p.polrelid = c.oid
          and p.polpermissive is false
          and p.polcmd = '*'
          and p.polroles = array[0::oid]
      )
    order by c.relname
  loop
    seal_oid := s.reloid;
    sealed_total := sealed_total + 1;

    -- An empty table never reaches the quarantine branch, so there is no verdict
    -- to attribute and nothing for the control to prove.
    execute format('select count(*) from public.%I where family_id = %L',
                   s.tbl, '00000000-0000-4000-8000-0000000000f1') into seal_rows;
    if seal_rows = 0 then
      continue;
    end if;
    sealed_seen := sealed_seen + 1;

    -- (0) The quarantine must be IN FORCE. 0262 enables RLS in the same block
    -- that creates the deny-all; with RLS off the policy is inert and there is
    -- no quarantine to attribute anything to.
    if not s.rls_on then
      notes := notes || format(
        '%s is populated and carries the deny-all policy, but row level security is DISABLED on it, so the policy is inert and nothing here is quarantined — 0262 enables RLS in the same block that creates the policy, and half of that has been undone',
        s.tbl);
      continue;
    end if;

    -- (a) The privilege layer must answer YES for the actor the verdict uses,
    -- for exactly the privilege the statement under test needs: SELECT on
    -- family_id, the only column it reads. A table-level grant implies it and a
    -- column-level grant supplies it; only when neither exists does the read
    -- raise 42501, and then the restrictive policy is being credited for the
    -- grant layer's refusal. Deliberately not preceded by has_table_privilege:
    -- table-level SELECT true makes this true for every column, so a second
    -- test after it could never fire.
    if not has_column_privilege('authenticated'::name, seal_oid, 'family_id'::text, 'SELECT') then
      notes := notes || format(
        '%s is populated and sealed, but `authenticated` holds no SELECT reaching its family_id column — neither table-level nor column-level — so the statement under test raises 42501, the loop records -1 and counts the table as "verified closed": a refusal from the GRANT layer credited to 0262''s restrictive policy',
        s.tbl);
      continue;
    end if;

    -- (b) The permissive SELECT predicates the restrictive constant ANDs with —
    -- ALL of them, sorted, because permissive policies OR together and the read
    -- under test flows through that OR, not through whichever name sorts first.
    -- Without any the table is shut by plain default-deny, the quarantine is not
    -- what is closing it, and lifting the quarantine would not re-open it.
    preds := null;
    select array_agg(distinct pg_get_expr(p.polqual, p.polrelid)
                     order by pg_get_expr(p.polqual, p.polrelid))
      into preds
    from pg_catalog.pg_policy p
    where p.polrelid = seal_oid
      and p.polpermissive
      and p.polcmd in ('r', '*')
      and p.polqual is not null
      and (p.polroles = array[0::oid] or 'authenticated'::regrole::oid = any (p.polroles));
    if preds is null then
      notes := notes || format(
        '%s is populated and sealed, but carries no permissive SELECT policy reaching `authenticated`, so its zero rows are default-deny and not the quarantine''s doing: rewrite the deny-all to `using (true)` and this probe would still report it closed. Restore the permissive policy or retire the quarantine branch — do not leave the verdict unattributable',
        s.tbl);
      continue;
    end if;
    pred_txt := array_to_string(preds, ' OR ');

    -- (c) The twin: the SAME predicate SET, by expression and not by
    -- resemblance, with RLS enabled, no restrictive policy over SELECT, and
    -- anchor-family rows to find. This is the one thing the mechanism keys on,
    -- changed. Set equality is what rules out a twin that carries the right
    -- predicate beside a broader one — that twin lands through the broader one
    -- while `is_family_member` may be answering false.
    twin_tbl := null;
    twin_rows := null;
    for cand in
      select c.relname as tbl, c.oid as reloid
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join information_schema.columns col
        on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'family_id'
      where ns.nspname = 'public' and c.relkind = 'r' and c.oid <> seal_oid
        and c.relrowsecurity
        and (
          select array_agg(distinct pg_get_expr(p.polqual, p.polrelid)
                           order by pg_get_expr(p.polqual, p.polrelid))
          from pg_catalog.pg_policy p
          where p.polrelid = c.oid
            and p.polpermissive
            and p.polcmd in ('r', '*')
            and p.polqual is not null
            and (p.polroles = array[0::oid] or 'authenticated'::regrole::oid = any (p.polroles))
        ) = preds
        and not exists (
          select 1 from pg_catalog.pg_policy p
          where p.polrelid = c.oid
            and p.polpermissive is false
            and p.polcmd in ('r', '*')
        )
      order by c.relname
    loop
      -- The grant test is deliberately OUT of the query above and in here.
      -- `has_column_privilege(..., 'family_id', ...)` RAISES on a table with no
      -- such column, and nothing makes a planner apply the information_schema
      -- join before a function in the same WHERE clause — so in the query it
      -- would be an error waiting for the first family_id-less table the scan
      -- reaches, not a filter. One test, for the reason given at (a).
      if not has_column_privilege('authenticated'::name, cand.reloid, 'family_id'::text, 'SELECT') then
        continue;
      end if;
      execute format('select count(*) from public.%I where family_id = %L',
                     cand.tbl, '00000000-0000-4000-8000-0000000000f1') into cand_rows;
      if cand_rows > 0 then
        twin_tbl := cand.tbl;
        twin_rows := cand_rows;
        exit;
      end if;
    end loop;
    if twin_tbl is null then
      notes := notes || format(
        '%s is populated and sealed, but no other family-scoped table with RLS enabled carries exactly its permissive SELECT predicate set (%s) with anchor-family rows and no restrictive policy over SELECT, so there is nothing to run the same actor through the same predicate against and the quarantine verdict cannot be attributed',
        s.tbl, pred_txt);
      continue;
    end if;

    -- (d) The control read, as the very session the verdict is measured in.
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    begin
      execute format('select count(*) from public.%I where family_id = %L',
                     twin_tbl, '00000000-0000-4000-8000-0000000000f1') into landed;
    exception when insufficient_privilege then
      landed := -1;
    end;
    perform set_config('role', 'none', true);

    if landed <= 0 then
      notes := notes || format(
        'CONTROL FAILED for %s: the anchor family''s own parent read %s of %s row(s) from %s through the SAME predicate (%s) with no quarantine in the way, so this session never had the visibility the quarantine verdict measures — its zero rows on %s are explained by the actor (a dead auth.uid(), a role switch that did not take, UA not being an active member of FA, or SELECT revoked from authenticated), and 0262 would be credited for a closure it may have had no part in',
        s.tbl,
        case when landed < 0 then 'no grant' else landed::text end,
        twin_rows, twin_tbl, pred_txt, s.tbl);
    else
      proved := proved || format('%s sealed, while the same parent reads %s of %s row(s) in %s through the same predicate %s',
                                 s.tbl, landed, twin_rows, twin_tbl, pred_txt);
    end if;
  end loop;

  if array_length(notes, 1) is not null then
    raise exception 'QUARANTINE VERDICT UNPROVEN (the control it rests on did not hold): %',
      array_to_string(notes, ' | ');
  end if;
  -- Three endings, and the runner reads them differently on purpose. No
  -- deny-all table at all is not a skip: the quarantine rule has an empty
  -- domain and every populated table is under the ordinary rule below (that is
  -- the designed fallback when a quarantine is lifted). A deny-all table that
  -- holds no anchor-family rows IS a skip — the quarantine half of the verdict
  -- has a subject and declined to examine it, which happened once already (see
  -- 0285) — and run-probes.sh keys on the uppercase word to say so instead of
  -- printing PASS over an invariant that never ran.
  if sealed_total = 0 then
    raise notice 'quarantine control: no family-scoped table carries a deny-all restrictive policy on this database, so nothing is quarantined and every populated table falls under the ordinary self-read rule below';
  elsif sealed_seen = 0 then
    raise notice 'quarantine control SKIPPED: % deny-all table(s) exist but none holds anchor-family rows, so the quarantine half of the verdict below is not exercised and has nothing to attribute — a seed regression (the shape 0285 fixed), not a pass',
      sealed_total;
  else
    raise notice 'quarantine control OK: %', array_to_string(proved, '; ');
  end if;
end $control$;


do $$
declare
  r record;
  owner_rows int;
  member_rows int;
  checked int := 0;
  skipped int := 0;
  quarantined int := 0;
  sealed boolean;
  blind text[] := '{}';
  leaked text[] := '{}';
begin
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join information_schema.columns col
      on col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'family_id'
    where ns.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    -- As the owner: does the anchor family have anything here at all?
    execute format('select count(*) from public.%I where family_id = %L',
                   r.tbl, '00000000-0000-4000-8000-0000000000f1') into owner_rows;
    if owner_rows = 0 then
      skipped := skipped + 1;
      continue;
    end if;

    -- Is this table under a deliberate deny-all quarantine? RESTRICTIVE
    -- policies compose with AND, so one of these over all commands for PUBLIC
    -- closes the table no matter what permissive policies sit beside it.
    -- Deliberately NOT `and pg_get_expr(p.polqual, ...) = 'false'`. Matching the
    -- shape rather than the expression is what makes the check below able to
    -- fail: rewrite the quarantine to `using (true)` and the table is still
    -- recognised as one that is supposed to be closed, and is then caught being
    -- open. Pinning the expression would have made that branch unreachable.
    --
    -- The shape is specific enough to mean only this: every other restrictive
    -- policy in the schema is a per-command write guard (`d`/`a`/`w`) granted to
    -- named roles (`authenticated`, and on family_playbook_suggestions `anon`
    -- too), never `*` and never PUBLIC.
    select exists (
      select 1
      from pg_catalog.pg_policy p
      where p.polrelid = format('public.%I', r.tbl)::regclass
        and p.polpermissive is false
        and p.polcmd = '*'
        and p.polroles = array[0::oid]
    ) into sealed;

    -- As the anchor family's own parent: they must be able to see them.
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    begin
      execute format('select count(*) from public.%I where family_id = %L',
                     r.tbl, '00000000-0000-4000-8000-0000000000f1') into member_rows;
    exception when insufficient_privilege then
      member_rows := -1;   -- no grant at all: also blind, and worth naming as such
    end;
    perform set_config('role', 'none', true);   -- back to the session user, whatever it is called

    if sealed then
      -- The invariant is inverted here: closed is correct, open is the failure.
      quarantined := quarantined + 1;
      if member_rows > 0 then
        leaked := leaked || format('%s (quarantined by a restrictive deny-all policy, yet the family reads %s row(s))',
                                   r.tbl, member_rows);
      end if;
      continue;
    end if;

    checked := checked + 1;
    if member_rows <= 0 then
      blind := blind || format('%s (owner sees %s, the family sees %s)', r.tbl, owner_rows,
                               case when member_rows < 0 then 'no grant' else '0' end);
    end if;
  end loop;

  if array_length(leaked, 1) > 0 then
    raise exception 'QUARANTINE FAIL: a deny-all table is readable in % table(s): %',
      array_length(leaked, 1), array_to_string(leaked, '; ');
  end if;
  if array_length(blind, 1) > 0 then
    raise exception 'SELF-READ FAIL: the anchor family cannot read its own rows in % table(s): %',
      array_length(blind, 1), array_to_string(blind, '; ');
  end if;
  raise notice 'self-read OK: the family reads its own rows in all % populated family-scoped tables (% empty, skipped; % deliberately quarantined and verified closed)',
    checked, skipped, quarantined;
end $$;

select 'family self-read probe: ALL INVARIANTS PASSED' as result;
