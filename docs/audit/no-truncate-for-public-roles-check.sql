-- ── 0312: the public roles hold no TRUNCATE privilege ───────────────────────
--
-- RLS does not constrain TRUNCATE: `using (false)` on sync_tokens does not stop
-- `truncate public.sync_tokens`, because the privilege is checked against the
-- GRANT and never against the policy. Supabase's defaults hand anon and
-- authenticated the full set on new tables, so this has to be re-checked on
-- every replay rather than trusted once — a table created by a later migration
-- arrives with the grant unless something takes it away.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/no-truncate-for-public-roles-check.sql
--
-- Audit C3-S3-02 (the marketing spine) and C3-S5-09 (both credential stores).
do $$
declare n int; sample text;
begin
  select count(*), coalesce(min(table_name), '-') into n, sample
    from information_schema.role_table_grants
   where table_schema = 'public'
     and privilege_type = 'TRUNCATE'
     and grantee in ('anon', 'authenticated');
  if n <> 0 then
    raise exception '0312: % table(s) still grant TRUNCATE to anon/authenticated (e.g. %) — RLS does not cover this', n, sample;
  end if;

  -- The two that matter most, named so a failure says which boundary moved.
  select count(*) into n
    from information_schema.role_table_grants
   where table_name in ('sync_tokens', 'social_account_tokens')
     and privilege_type = 'TRUNCATE'
     and grantee in ('anon', 'authenticated');
  if n <> 0 then
    raise exception '0312: a credential store still grants TRUNCATE to a public role (% grant(s))', n;
  end if;

  raise notice '0312 OK: no TRUNCATE for anon or authenticated anywhere in public';
end $$;
