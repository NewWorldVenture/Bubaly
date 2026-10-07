\set ON_ERROR_STOP on
-- Empty disposable DB only. Keep Supabase's public default privilege parity;
-- the candidate must narrow its own function ACLs rather than inherit a safe
-- synthetic default. Never grant the service client access to auth.users.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin bypassrls; end if;
end $$;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
-- Reuse the actual 0134/0249 dirty marker, 0211 membership RLS, 0299 deferred
-- manager constraint, 0419 assistant retirement, 0458 login guard and 0476
-- membership ordering fixture. This is focused schema replay, not every migration.
\set keep_fixture true
\ir messaging-preserve-access.sql
revoke all on auth.users from public,anon,authenticated,service_role;
grant usage on schema auth to supabase_auth_admin;
grant all on auth.users to supabase_auth_admin;
\ir ../../supabase/migrations/0018_sync_platform.sql
\ir ../../supabase/migrations/0291_sync_log_skips_deleted_family.sql
\ir ../../supabase/migrations/0346_a_calendar_connection_belongs_to_its_owner.sql
\ir ../../supabase/migrations/0355_the_sync_engines_tables_are_not_a_members_write.sql
\ir ../../supabase/reserved/0494_sync_atomic_pull.sql
\ir ../../supabase/reserved/0494_sync_atomic_pull.sql
select 'sync atomic pull fixture: actual sync schema, role policies and membership lifecycle loaded' as result;
