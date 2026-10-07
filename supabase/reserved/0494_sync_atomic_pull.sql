-- Standard sync pull: admit the persisted account and create mirror containers
-- or a remote item plus its mapping in one transaction. Existing mappings are
-- validated and returned without overwriting conflict/update decisions.
-- No table privileges or RLS policies are changed. Only service_role may call.
-- Account serialization precedes nonblocking family/auth-user/account/member
-- admission; a concurrent deletion or identity change fails and remains retryable.
-- The private definer helper locks only the existing account owner and returns
-- no auth data, avoiding additional service_role privileges on auth.users.
create schema if not exists sync_pull_private;
revoke all on schema sync_pull_private from public,anon,authenticated;
grant usage on schema sync_pull_private to service_role;

create or replace function sync_pull_private.lock_auth_parent(p_account uuid,p_family uuid,p_user uuid,p_provider public.sync_provider)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if pg_catalog.current_setting('role',true) is distinct from 'service_role' then
  raise exception 'Service role required' using errcode='42501';
 end if;
 perform u.id from auth.users u join public.sync_accounts a on a.user_id=u.id
 where a.id=p_account and a.family_id=p_family and a.user_id=p_user and a.provider=p_provider
 for key share of u nowait;
 if not found then raise exception 'Sync owner unavailable' using errcode='42501'; end if;
end $$;
revoke all on function sync_pull_private.lock_auth_parent(uuid,uuid,uuid,public.sync_provider) from public,anon,authenticated;
grant execute on function sync_pull_private.lock_auth_parent(uuid,uuid,uuid,public.sync_provider) to service_role;

create or replace function sync_pull_private.admit_account(p_account uuid,p_family uuid,p_user uuid,p_provider public.sync_provider,p_require_pull boolean)
returns void language plpgsql security invoker set search_path = '' as $$
declare a public.sync_accounts; m public.family_members;
begin
 if current_user <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
 if p_account is null or p_family is null or p_user is null or p_provider is null then
  raise exception 'Sync identity unavailable' using errcode='42501';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bubaly:sync-pull:'||p_account::text,0));
 perform f.id from public.families f where f.id=p_family for key share of f nowait;
 if not found then raise exception 'Sync household unavailable' using errcode='42501'; end if;
 perform sync_pull_private.lock_auth_parent(p_account,p_family,p_user,p_provider);
 select * into a from public.sync_accounts where id=p_account for update nowait;
 if not found or a.family_id is distinct from p_family or a.user_id is distinct from p_user or a.provider is distinct from p_provider then
  raise exception 'Sync identity changed' using errcode='42501';
 end if;
 if a.sync_direction not in ('import','export','two_way') or (p_require_pull and a.sync_direction not in ('import','two_way')) or jsonb_typeof(a.metadata) is distinct from 'object' or a.metadata ? 'onboardingCalendar' then
  raise exception 'Standard pull unavailable' using errcode='42501';
 end if;
 select * into m from public.family_members where family_id=p_family and user_id=p_user and is_active for share nowait;
 if not found then raise exception 'Active sync owner unavailable' using errcode='42501'; end if;
end $$;
revoke all on function sync_pull_private.admit_account(uuid,uuid,uuid,public.sync_provider,boolean) from public,anon,authenticated;
grant execute on function sync_pull_private.admit_account(uuid,uuid,uuid,public.sync_provider,boolean) to service_role;

create or replace function public.ensure_sync_pull_container(p_account uuid,p_family uuid,p_user uuid,p_provider public.sync_provider,p_kind public.sync_item_type,p_external text,p_name text,p_timezone text,p_color text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare ids uuid[]; cal public.sync_calendars; lst public.sync_reminder_lists;
begin
 if current_user <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
 if p_kind is null or p_kind not in ('event','reminder') or p_external is null or btrim(p_external)='' then raise exception 'Invalid container identity' using errcode='22023'; end if;
 perform sync_pull_private.admit_account(p_account,p_family,p_user,p_provider,false);
 if p_kind='event' then
  select array_agg(id order by id) into ids from public.sync_calendars where account_id=p_account and provider=p_provider and external_id=p_external;
  if cardinality(ids)>1 then raise exception 'Ambiguous sync calendar' using errcode='42501'; end if;
  if cardinality(ids)=1 then
   select * into cal from public.sync_calendars where id=ids[1] for update nowait;
   if cal.family_id is distinct from p_family or cal.user_id is distinct from p_user or cal.account_id is distinct from p_account or cal.provider is distinct from p_provider or cal.external_id is distinct from p_external then raise exception 'Calendar scope changed' using errcode='42501'; end if;
  else
   insert into public.sync_calendars(family_id,user_id,account_id,provider,external_id,name,timezone,color,is_owned_locally)
   values(p_family,p_user,p_account,p_provider,p_external,p_name,p_timezone,p_color,false) returning * into cal;
  end if;
  return jsonb_build_object('id',cal.id,'sync_token',cal.sync_token);
 else
  select array_agg(id order by id) into ids from public.sync_reminder_lists where account_id=p_account and provider=p_provider and external_id=p_external;
  if cardinality(ids)>1 then raise exception 'Ambiguous sync reminder list' using errcode='42501'; end if;
  if cardinality(ids)=1 then
   select * into lst from public.sync_reminder_lists where id=ids[1] for update nowait;
   if lst.family_id is distinct from p_family or lst.user_id is distinct from p_user or lst.account_id is distinct from p_account or lst.provider is distinct from p_provider or lst.external_id is distinct from p_external then raise exception 'Reminder list scope changed' using errcode='42501'; end if;
  else
   insert into public.sync_reminder_lists(family_id,user_id,account_id,provider,external_id,name,is_owned_locally)
   values(p_family,p_user,p_account,p_provider,p_external,p_name,false) returning * into lst;
  end if;
  return jsonb_build_object('id',lst.id,'sync_token',lst.sync_token);
 end if;
end $$;
revoke all on function public.ensure_sync_pull_container(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ensure_sync_pull_container(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,text,text,text,text) to service_role;

create or replace function public.create_sync_pull_item(p_account uuid,p_family uuid,p_user uuid,p_provider public.sync_provider,p_kind public.sync_item_type,p_container uuid,p_external text,p_fields jsonb,p_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare cal public.sync_calendars; lst public.sync_reminder_lists; map public.sync_external_mappings; item_id uuid; item_provider public.sync_provider; item_external text; got_item boolean;
begin
 if current_user <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
 if p_kind is null or p_kind not in ('event','reminder') or p_container is null or p_external is null or btrim(p_external)='' or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(p_fields->'title') is distinct from 'string' then raise exception 'Invalid sync item' using errcode='22023'; end if;
 perform sync_pull_private.admit_account(p_account,p_family,p_user,p_provider,true);
 if p_kind='event' then
  select * into cal from public.sync_calendars where id=p_container for share nowait;
  if not found or cal.family_id is distinct from p_family or cal.user_id is distinct from p_user or cal.account_id is distinct from p_account or cal.provider is distinct from p_provider then raise exception 'Calendar scope unavailable' using errcode='42501'; end if;
 else
  select * into lst from public.sync_reminder_lists where id=p_container for share nowait;
  if not found or lst.family_id is distinct from p_family or lst.user_id is distinct from p_user or lst.account_id is distinct from p_account or lst.provider is distinct from p_provider then raise exception 'Reminder list scope unavailable' using errcode='42501'; end if;
 end if;
 select * into map from public.sync_external_mappings where account_id=p_account and provider=p_provider and item_type=p_kind and external_id=p_external for update nowait;
 if found then
  if map.family_id is distinct from p_family or jsonb_typeof(map.metadata) is distinct from 'object' or (map.metadata ? 'sourceTable') then raise exception 'Mapping scope unavailable' using errcode='42501'; end if;
  if p_kind='event' then
   select id,provider,external_id into item_id,item_provider,item_external from public.sync_calendar_events where id=map.local_id and family_id=p_family and calendar_id=p_container for share nowait;
   got_item:=found;
  else
   select id,provider,external_id into item_id,item_provider,item_external from public.sync_reminders where id=map.local_id and family_id=p_family and list_id=p_container for share nowait;
   got_item:=found;
  end if;
  if not got_item or item_provider not in ('internal',p_provider) or (item_provider <> 'internal' and item_external is distinct from p_external) then raise exception 'Mapped item scope unavailable' using errcode='42501'; end if;
  return jsonb_build_object('created',false,'mapping',jsonb_build_object('id',map.id,'family_id',map.family_id,'local_id',map.local_id,'external_id',map.external_id,'metadata',map.metadata));
 end if;
 if p_kind='event' then
  insert into public.sync_calendar_events(calendar_id,family_id,user_id,provider,external_id,uid,title,description,location,starts_at,ends_at,all_day,recurrence_rule,status,etag,content_hash,sync_status,last_synced_at,metadata)
  values(p_container,p_family,p_user,p_provider,p_external,p_fields->>'uid',p_fields->>'title',p_fields->>'description',p_fields->>'location',(p_fields->>'starts_at')::timestamptz,(p_fields->>'ends_at')::timestamptz,coalesce((p_fields->>'all_day')::boolean,false),p_fields->>'recurrence_rule',coalesce(p_fields->>'status','confirmed'),p_fields->>'etag',p_hash,'synced',now(),'{"origin":"remote"}') returning id into item_id;
 else
  insert into public.sync_reminders(list_id,family_id,user_id,provider,external_id,title,notes,due_at,is_completed,completed_at,content_hash,sync_status,last_synced_at,metadata)
  values(p_container,p_family,p_user,p_provider,p_external,p_fields->>'title',p_fields->>'notes',(p_fields->>'due_at')::timestamptz,coalesce((p_fields->>'is_completed')::boolean,false),(p_fields->>'completed_at')::timestamptz,p_hash,'synced',now(),'{"origin":"remote"}') returning id into item_id;
 end if;
 insert into public.sync_external_mappings(family_id,account_id,provider,item_type,local_id,external_id,external_etag,metadata,last_synced_at)
 values(p_family,p_account,p_provider,p_kind,item_id,p_external,p_fields->>'etag',jsonb_build_object('lastHash',p_hash),now()) returning * into map;
 return jsonb_build_object('created',true,'mapping',jsonb_build_object('id',map.id,'family_id',map.family_id,'local_id',map.local_id,'external_id',map.external_id,'metadata',map.metadata));
end $$;
revoke all on function public.create_sync_pull_item(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_sync_pull_item(uuid,uuid,uuid,public.sync_provider,public.sync_item_type,uuid,text,jsonb,text) to service_role;
