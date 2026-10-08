-- PREPARED ONLY: no hosted execution or production acceptance is recorded.
-- Before applying the selected bill/chat/AI privacy/sync candidates, a human with approved
-- catalog access can run this inside a READ ONLY transaction. Save its metadata
-- output with the exact release commit and compare to that candidate's clean
-- synthetic replay. Absence before a candidate applies is expected; wrong
-- existing column types/defaults, constraints, indexes or effective grants are
-- drift requiring reconciliation. IF NOT EXISTS does not validate those shapes.
-- This file performs no DDL, role changes, migration, configuration or money
-- operation. It returns catalog metadata and aggregate counts, never messages,
-- identities, family IDs, credentials or general function bodies.
begin transaction read only;
set local statement_timeout = '15s';

-- Missing objects must have explicit rows: a filtered catalog query returning
-- nothing is not an absence/safety verdict. This is inventory, not an apply gate.
with expected(table_name) as (values
  ('calendar_feeds'),('calendar_events'),('calendar_feed_source_revisions'),
  ('calendar_feed_source_groups'),('calendar_feed_source_component_watermarks'))
select e.table_name, c.oid is not null as present,
       c.relkind, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls,
       pg_get_userbyid(c.relowner) as table_owner
from expected e left join pg_class c on c.oid=to_regclass('public.'||e.table_name)
order by e.table_name;

with expected(identity) as (values
  ('public.calendar_feed_apply_sync(uuid,timestamp with time zone,jsonb,text[])'),
  ('public.calendar_feed_publish_snapshot(uuid,timestamp with time zone,jsonb,text[])'),
  ('public.calendar_feed_archive_sources(uuid,timestamp with time zone,jsonb)'),
  ('public.calendar_read_occurrence_inputs(uuid)'),
  ('calendar_feed_private.raw_identity(text,text,text)'),
  ('calendar_feed_private.validate_value(jsonb,text,text)'),
  ('calendar_feed_private.archive_document(jsonb,text)'),
  ('calendar_feed_private.compare_revision(jsonb,jsonb)'),
  ('calendar_feed_private.immutable_archive()'),
  ('calendar_feed_private.prevent_archive_reparent()'),
  ('calendar_feed_private.refuse_read(text,text)'))
select e.identity, to_regprocedure(e.identity) is not null as present
from expected e order by e.identity;

with expected(schema_name) as (values ('calendar_feed_private')),
callers(role_name) as (values ('anon'),('authenticated'),('service_role'))
select e.schema_name, c.role_name, n.oid is not null as schema_present,
       r.oid is not null as role_present, pg_get_userbyid(n.nspowner) as schema_owner,
       has_schema_privilege(r.oid,n.oid,'USAGE') as effective_usage,
       has_schema_privilege(r.oid,n.oid,'CREATE') as effective_create
from expected e cross join callers c
left join pg_namespace n on n.nspname=e.schema_name
left join pg_roles r on r.rolname=c.role_name
order by e.schema_name,c.role_name;

select current_setting('server_version_num') as server_version_num,
       current_setting('transaction_read_only') as transaction_read_only,
       to_regclass('supabase_migrations.schema_migrations') is not null as has_migration_ledger,
       current_setting('pgrst.db_schemas', true) as available_postgrest_exposed_schema_setting;

-- Include the membership/model tables: their triggers and FKs interact with
-- parent-family deletion even when the message-table fixture passes.
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls,
       pg_get_userbyid(c.relowner) as table_owner,
       a.attname as column_name, format_type(a.atttypid, a.atttypmod) as column_type,
       a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as column_default
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relname in
  ('families','family_members','family_model_dirty','family_conversations','family_messages','bills',
   'approval_requests','ai_requests','ai_request_context','family_automation_runs',
   'ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
   'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks')
order by c.relname, a.attnum;

select c.relname as table_name, k.conname as constraint_name, k.contype,
       k.convalidated, k.condeferrable, k.condeferred,
       pg_get_constraintdef(k.oid) as constraint_definition
from pg_constraint k join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in
  ('families','family_members','family_model_dirty','family_conversations','family_messages','bills',
   'approval_requests','ai_requests','ai_request_context','family_automation_runs',
   'ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
   'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks')
order by c.relname, k.conname;

select c.relname as table_name, ic.relname as index_name,
       i.indisunique, i.indisvalid, i.indisready,
       pg_get_indexdef(i.indexrelid) as index_definition,
       pg_get_expr(i.indpred, i.indrelid) as index_predicate
from pg_index i join pg_class c on c.oid = i.indrelid
join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('family_members','family_conversations','bills','approval_requests','ai_requests',
  'ai_request_context','family_automation_runs','ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
  'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks')
order by c.relname, ic.relname;

select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' and tablename in
  ('families','family_members','family_model_dirty','family_conversations','family_messages',
   'approval_requests','ai_requests','ai_request_context','family_automation_runs',
   'ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
   'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks',
   'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
   'allowance_rules','financial_accounts','transactions','budgets','bills','savings_goals')
order by tablename, policyname;

select c.relname as table_name, t.tgname as trigger_name, t.tgenabled,
       t.tgisinternal, t.tgdeferrable, t.tginitdeferred,
       pg_get_triggerdef(t.oid) as trigger_definition,
       pn.nspname as function_schema, p.proname as function_name,
       pg_get_userbyid(p.proowner) as function_owner, p.prosecdef as security_definer,
       (select s from unnest(coalesce(p.proconfig, '{}'::text[])) s
        where s like 'search_path=%' limit 1) as function_search_path,
       md5(pg_get_functiondef(p.oid)) as function_definition_hash
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
where n.nspname = 'public' and c.relname in
  ('families','family_members','family_model_dirty','family_conversations','family_messages','bills',
   'approval_requests','ai_requests','ai_request_context','family_automation_runs',
   'ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
   'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks')
order by c.relname, t.tgname;

-- All overloads/default argument counts, including retired one-argument RPCs.
select n.nspname as schema_name, p.proname,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       pg_get_function_result(p.oid) as result_type, p.pronargdefaults as default_argument_count,
       pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
       (select s from unnest(coalesce(p.proconfig, '{}'::text[])) s
        where s like 'search_path=%' limit 1) as search_path,
       md5(pg_get_functiondef(p.oid)) as definition_hash,
       r.rolname as caller_role, has_schema_privilege(r.oid,n.oid,'USAGE') as schema_usage,
       has_function_privilege(r.oid,p.oid,'EXECUTE') as effective_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where p.prokind = 'f' and r.rolname in ('anon','authenticated','service_role')
  and (n.nspname in ('messaging_private','sync_pull_private','calendar_feed_private') or (n.nspname = 'public' and p.proname in
       ('ensure_family_conversation','send_family_message','find_family_message',
        'mark_conversation_read','is_family_member','can_manage_family','is_family_admin','mark_model_dirty','count_family_ai_requests_month',
        'ensure_sync_pull_container','create_sync_pull_item','calendar_feed_apply_sync',
        'calendar_feed_publish_snapshot','calendar_feed_archive_sources','calendar_read_occurrence_inputs')))
order by n.nspname,p.proname,identity_arguments,r.rolname;

select n.nspname as schema_name,p.proname,
       pg_get_function_identity_arguments(p.oid) as identity_arguments,
       pg_describe_object(d.classid,d.objid,d.objsubid) as dependent_object,d.deptype
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
join pg_depend d on d.refclassid = 'pg_proc'::regclass and d.refobjid = p.oid
where n.nspname in ('public','messaging_private')
  and p.proname = 'ensure_family_conversation' and p.pronargs = 1
order by n.nspname,dependent_object;

-- Effective privileges include direct grants, PUBLIC grants and inheritance.
select c.relname as table_name,r.rolname as caller_role,
       has_table_privilege(r.oid,c.oid,'SELECT') as effective_select,
       has_table_privilege(r.oid,c.oid,'INSERT') as effective_insert,
       has_table_privilege(r.oid,c.oid,'UPDATE') as effective_update,
       has_table_privilege(r.oid,c.oid,'DELETE') as effective_delete,
       a.attname as column_name,has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE') as effective_column_update
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum > 0 and not a.attisdropped
cross join pg_roles r
where n.nspname='public' and c.relname in ('family_conversations','family_messages','bills','approval_requests','ai_requests',
  'ai_request_context','family_automation_runs','ai_tool_calls','ai_plans','ai_plan_steps','ai_run_events',
  'sync_accounts','sync_external_mappings','sync_change_logs','sync_calendars','sync_calendar_events','sync_reminder_lists','sync_reminders',
   'calendar_feeds','calendar_events','calendar_feed_source_revisions','calendar_feed_source_groups','calendar_feed_source_component_watermarks')
  and r.rolname in ('anon','authenticated','service_role')
order by c.relname,r.rolname,a.attnum;

select coalesce(n.nspname,'*') as schema_name,pg_get_userbyid(d.defaclrole) as owner,
       d.defaclobjtype,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type,a.is_grantable
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
where d.defaclnamespace=0 or n.nspname in ('public','messaging_private','sync_pull_private','calendar_feed_private')
order by schema_name,owner,d.defaclobjtype,grantee,a.privilege_type;

-- These aggregates require the ordinary preexisting message tables. Missing
-- relations fail visibly; do not treat partial output as catalog acceptance.
select count(*) as legacy_conversations,
       count(*) filter(where cardinality(participant_ids)=0 and cardinality(member_ids)=0) as empty_rosters,
       count(*) filter(where is_archived) as archived_conversations,
       count(*) filter(where created_by is null) as unattributed_conversations
from public.family_conversations;
select count(*) as mismatched_message_family_stamps
from public.family_messages m join public.family_conversations c on c.id=m.conversation_id
where m.family_id is distinct from c.family_id;

-- Save the version/name inventory separately ONLY if has_migration_ledger=true:
-- select version,name from supabase_migrations.schema_migrations order by version;
-- If the canonical column already exists, aggregate duplicate canonical
-- families without returning family IDs:
-- select count(*) as duplicate_canonical_groups from
-- (select 1 from public.family_conversations where is_family_chat
--  group by family_id having count(*)>1) duplicates;
rollback;
