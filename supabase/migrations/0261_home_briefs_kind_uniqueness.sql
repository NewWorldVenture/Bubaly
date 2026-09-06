-- 0261: let the daily brief and evening recap coexist without losing uniqueness.
-- 0140's two-column constraint still conflicts with 0258's three-column index.
-- Keep historical migrations intact. Validate the replacement before removing
-- only the obsolete unique constraints, including renamed/reordered equivalents.
-- One DO statement makes every check and constraint removal atomic. A rerun is
-- a no-op when the old constraint is absent and the replacement remains usable.

do $migration$
declare
  brief_table oid := to_regclass('public.home_briefs');
  family_column smallint;
  date_column smallint;
  kind_column smallint;
  legacy record;
begin
  if brief_table is null then
    raise exception '0261: public.home_briefs is missing; apply the prerequisite migrations first';
  end if;

  -- Hold the same table lock needed by the DDL while checking its catalogs.
  lock table only public.home_briefs in access exclusive mode;
  if not exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = brief_table and c.relkind = 'r'
  ) then
    raise exception '0261: public.home_briefs is not an ordinary table; review this baseline';
  end if;

  select attnum into family_column
  from pg_catalog.pg_attribute
  where attrelid = brief_table and attname = 'family_id'
    and atttypid = 'pg_catalog.uuid'::regtype and attnotnull and not attisdropped;

  select attnum into date_column
  from pg_catalog.pg_attribute
  where attrelid = brief_table and attname = 'as_of_date'
    and atttypid = 'pg_catalog.date'::regtype and attnotnull and not attisdropped;

  select attnum into kind_column
  from pg_catalog.pg_attribute
  where attrelid = brief_table and attname = 'kind'
    and atttypid = 'pg_catalog.text'::regtype and attnotnull and not attisdropped;

  if family_column is null or date_column is null or kind_column is null then
    raise exception '0261: expected non-null family_id uuid, as_of_date date and kind text columns';
  end if;

  -- A name alone does not prove the index is usable by the three-column upsert.
  -- Check key attributes, not their order; INCLUDE columns do not affect the key.
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = to_regclass('public.uq_home_briefs_family_date_kind')
      and i.indrelid = brief_table
      and i.indisunique and i.indisvalid and i.indisready and i.indislive
      and i.indimmediate
      and i.indpred is null and i.indexprs is null
      and i.indnkeyatts = 3
      and array[i.indkey[0], i.indkey[1], i.indkey[2]]
        @> array[family_column, date_column, kind_column]
  ) then
    raise exception '0261: the 0258 family/date/kind unique index is missing or unusable; review this baseline';
  end if;

  -- An unowned index or primary key on family/date is an unknown baseline.
  -- Do not silently leave a conflicting index behind or broaden the DDL to it.
  if exists (
    select 1 from pg_catalog.pg_index u
    where u.indrelid = brief_table and u.indisunique
      and u.indnkeyatts = 2
      and array[u.indkey[0], u.indkey[1]] @> array[family_column, date_column]
      and not exists (
        select 1 from pg_catalog.pg_constraint c
        where c.conrelid = brief_table and c.contype = 'u'
          and c.conindid = u.indexrelid
          and cardinality(c.conkey) = 2
          and c.conkey @> array[family_column, date_column]
      )
  ) then
    raise exception '0261: unexpected family/date unique index; review this baseline before removing constraints';
  end if;

  -- Names are not identities: only this table's exact two-column UNIQUE keys
  -- qualify. RESTRICT preserves dependent objects by failing rather than removing
  -- them; any failure rolls back this entire statement. Other keys stay intact.
  for legacy in
    select c.conname from pg_catalog.pg_constraint c
    where c.conrelid = brief_table and c.contype = 'u'
      and cardinality(c.conkey) = 2
      and c.conkey @> array[family_column, date_column]
  loop
    execute format(
      'alter table only public.home_briefs drop constraint %I restrict',
      legacy.conname
    );
  end loop;
end;
$migration$;
