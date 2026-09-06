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
  blind text[] := '{}';
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
    perform set_config('role', 'postgres', true);

    checked := checked + 1;
    if member_rows <= 0 then
      blind := blind || format('%s (owner sees %s, the family sees %s)', r.tbl, owner_rows,
                               case when member_rows < 0 then 'no grant' else '0' end);
    end if;
  end loop;

  if array_length(blind, 1) > 0 then
    raise exception 'SELF-READ FAIL: the anchor family cannot read its own rows in % table(s): %',
      array_length(blind, 1), array_to_string(blind, '; ');
  end if;
  raise notice 'self-read OK: the family reads its own rows in all % populated family-scoped tables (% empty, skipped)',
    checked, skipped;
end $$;

select 'family self-read probe: ALL INVARIANTS PASSED' as result;
