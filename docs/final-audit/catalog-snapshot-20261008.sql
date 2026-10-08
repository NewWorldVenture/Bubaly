-- Read-only production metadata snapshot. No application rows or credentials.
-- Run explicitly against the verified Bubaly project; not a migration or CI probe.
SELECT jsonb_build_object(
  'observed_at', statement_timestamp(),
  'server_version', current_setting('server_version'),
  'ledger', (SELECT jsonb_build_object('count',count(*),'latest_version',max(version)) FROM supabase_migrations.schema_migrations),
  'pending_ledger_versions', (SELECT coalesce(jsonb_agg(version ORDER BY version),'[]'::jsonb) FROM supabase_migrations.schema_migrations WHERE version IN ('0254','0475','0476','0488','0490','0492','0493','0494')),
  'held_functions', (SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid))), '[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('calendar_feed_apply_sync','count_family_ai_requests_month','ensure_sync_pull_container','create_sync_pull_item')),
  'bill_due_day', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bills' AND column_name='due_day'),
  'wallet_rls', (SELECT jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity) FROM pg_class WHERE oid=to_regclass('public.wallet_transactions')),
  'wallet_anon_privileges', jsonb_build_object('insert',has_table_privilege('anon','public.wallet_transactions','INSERT'),'update',has_table_privilege('anon','public.wallet_transactions','UPDATE'),'delete',has_table_privilege('anon','public.wallet_transactions','DELETE'),'inherits_authenticated',pg_has_role('anon','authenticated','USAGE')),
  'wallet_policies', (SELECT coalesce(jsonb_agg(jsonb_build_object('name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) ORDER BY policyname), '[]'::jsonb) FROM pg_policies WHERE schemaname='public' AND tablename='wallet_transactions'),
  'management_helpers', (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('can_manage_family','is_family_member')),
  'family_media', (SELECT jsonb_agg(jsonb_build_object('id',id,'public',public)) FROM storage.buckets WHERE id='family-media')
) AS audit_metadata;
