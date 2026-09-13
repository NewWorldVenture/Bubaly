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

\set FA '00000000-0000-4000-8000-0000000000f1'
\set UA '00000000-0000-4000-8000-000000000001'

grant select on all tables in schema public to authenticated;

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
    -- `authenticated`, never `*` and never PUBLIC.
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
