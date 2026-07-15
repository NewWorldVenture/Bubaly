-- Remove malformed Auth users created by the retired onboarding-progress seed.
-- GoTrue owns auth.users and its identity/metadata invariants; seed scripts must
-- never write that table directly.
--
-- These synthetic accounts (onb…@seed-onb.bubaly.test / person…@seed.bubaly.test)
-- are referenced across the schema. Some of those foreign keys do NOT cascade
-- (e.g. game_results.created_by), which blocked a plain DELETE with:
--   23503: update or delete on table "users" violates foreign key constraint
-- So we first delete every row that references the synthetic users via ANY
-- single-column foreign key to auth.users(id) — safe because these are seed-only
-- accounts — then remove the users one at a time so a single stubborn reference
-- can't abort the whole cleanup. Idempotent: re-running with no matches is a no-op.

begin;

do $$
declare
  v_ids            uuid[];
  synthetic_count  integer;
  fk               record;
  uid              uuid;
  removed          integer := 0;
  remaining        integer := 0;
begin
  select array_agg(id), count(*)
    into v_ids, synthetic_count
  from auth.users
  where email ~ '^(onb[0-9]+@seed-onb\.bubaly\.test|person[0-9]+@seed\.bubaly\.test)$';

  if v_ids is null then
    raise notice 'No retired synthetic Auth users found.';
    return;
  end if;

  if synthetic_count > 1000 then
    raise exception 'Refusing to remove % synthetic Auth users; expected at most 1000', synthetic_count;
  end if;

  -- 1) Clear every row that references these users through a single-column
  --    foreign key to auth.users(id), so a non-cascading FK can't block the
  --    delete. Best-effort per table: a failure (e.g. its own child FK) is
  --    noticed and skipped rather than aborting the migration.
  for fk in
    select con.conrelid::regclass::text as tbl, att.attname as col
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum   = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and array_length(con.conkey, 1) = 1
  loop
    begin
      execute format('delete from %s where %I = any($1)', fk.tbl, fk.col) using v_ids;
    exception when others then
      raise notice 'skip dependent cleanup on %(%): %', fk.tbl, fk.col, sqlerrm;
    end;
  end loop;

  -- 2) Remove the users individually so one remaining dependency can't abort
  --    the whole run; report how many were removed vs. still referenced.
  foreach uid in array v_ids loop
    begin
      delete from auth.users where id = uid;
      removed := removed + 1;
    exception when others then
      remaining := remaining + 1;
      raise notice 'could not remove synthetic user % (still referenced): %', uid, sqlerrm;
    end;
  end loop;

  raise notice 'Retired synthetic Auth users: % removed, % still referenced.', removed, remaining;
end $$;

commit;
