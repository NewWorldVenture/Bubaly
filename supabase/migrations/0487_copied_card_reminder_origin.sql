-- Complement after 0486; this private candidate is not production authorization.
BEGIN;
-- PRIVATE HELD CANDIDATE: no public ordinal, migration installation, or author edit.
-- Ordinary card resolution can update status/receipt fields, not its copied origin.
create or replace function public.keep_copied_card_origin()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  policy_member uuid;
  api_role text := current_setting('role', true);
begin
  -- Selected runtime supports these API roles. Owner-only seed/backfill remains external.
  if api_role not in ('authenticated', 'service_role') then
    return new;
  end if;
  if api_role = 'authenticated' and auth.uid() is null then
    raise exception using errcode='42501', message='Card actor unavailable';
  end if;
  if TG_OP='INSERT' then
    if new.kind='insurance' or new.source_kind='family_insurance_policies' then
      if new.source_kind is distinct from 'family_insurance_policies' or new.source_id is null then
        raise exception using errcode='42501',message='Insurance source unavailable';
      end if;
      select p.member_id into policy_member from public.family_insurance_policies p
        where p.id=new.source_id and p.family_id=new.family_id for share;
      if not found or new.member_id is distinct from policy_member then
        raise exception using errcode='42501',message='Insurance source unavailable';
      end if;
      if policy_member is not null and not exists(select 1 from public.family_members fm where fm.id=policy_member and fm.family_id=new.family_id and fm.is_active) then
        raise exception using errcode='42501',message='Insurance recipient unavailable';
      end if;
      if api_role='authenticated' and not public.can_manage_family(new.family_id)
        and not exists(select 1 from public.family_members fm where fm.id=policy_member and fm.family_id=new.family_id and fm.user_id=auth.uid() and fm.is_active) then
        raise exception using errcode='42501',message='Insurance recipient unavailable';
      end if;
    end if;
    return new;
  end if;
  if row(new.family_id, new.kind, new.source_kind, new.source_id)
       is distinct from row(old.family_id, old.kind, old.source_kind, old.source_id) then
    raise exception using errcode = '42501', message = 'A copied card origin cannot be changed.';
  end if;
  if new.member_id is distinct from old.member_id then
    if old.source_kind is distinct from 'family_insurance_policies'
       or old.source_id is null
       or (api_role = 'authenticated' and not public.can_manage_family(old.family_id)) then
      raise exception using errcode = '42501', message = 'A copied card audience cannot be changed.';
    end if;
    select p.member_id into policy_member
      from public.family_insurance_policies p
      where p.id = old.source_id and p.family_id = old.family_id
      for share;
    if not found or new.member_id is distinct from policy_member then
      raise exception using errcode = '42501', message = 'A copied card audience could not be verified.';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists keep_copied_card_origin on public.autopilot_suggestions;
create trigger keep_copied_card_origin before insert or update on public.autopilot_suggestions
  for each row execute function public.keep_copied_card_origin();

revoke all on function public.keep_copied_card_origin() from public, anon, authenticated, service_role;

-- PRIVATE SYNTHETIC CANDIDATE ONLY. No public migration ordinal or production install.
create schema if not exists reminder_origin_private;
revoke all on schema reminder_origin_private from public, anon, authenticated, service_role;
alter table public.family_reminders add column if not exists autopilot_origin boolean not null default false;
alter table public.family_reminders add column if not exists autopilot_card_id uuid;
alter table public.reminders add column if not exists autopilot_origin boolean not null default false;
alter table public.reminders add column if not exists autopilot_card_id uuid;
create or replace function reminder_origin_private.card_readable(c public.autopilot_suggestions, actor uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
 select actor is not null and exists(select 1 from public.family_members fm where fm.family_id=c.family_id and fm.user_id=actor and fm.is_active
 and case when c.source_kind='family_insurance_policies' or c.kind='insurance' then fm.role in('parent','adult') or exists(select 1 from public.family_members named where named.id=c.member_id and named.family_id=c.family_id and named.user_id=actor and named.is_active)
 when c.kind='finance' or c.source_kind in('subscriptions_tracked','renewals') then fm.role::text <> 'guest' else true end);
$$;
revoke all on function reminder_origin_private.card_readable(public.autopilot_suggestions,uuid) from public,anon,authenticated,service_role;
-- The flat family/card key has exactly the existing JavaScript JSON byte format.
create or replace function reminder_origin_private.card_key(family uuid, card uuid) returns text language sql immutable set search_path=pg_catalog,public as $$
 select encode(extensions.digest('["autopilot.createReminder","'||family::text||'","'||card::text||'"]','sha256'),'hex');
$$;
revoke all on function reminder_origin_private.card_key(uuid,uuid) from public,anon,authenticated,service_role;
-- Backfill exact stable-key links. Unmatched stamped copies remain manager-only.
update public.family_reminders r set autopilot_origin=true where not r.autopilot_origin and exists(select 1 from unnest(r.tags) t where t ~ '^autopilot-source:[a-f0-9]{64}$');
update public.family_reminders r set autopilot_origin=true,autopilot_card_id=null from public.autopilot_suggestions c where not r.autopilot_origin and c.family_id=r.family_id and c.action_type='create_reminder' and r.idempotency_key=reminder_origin_private.card_key(c.family_id,c.id);
update public.reminders set autopilot_origin=true where not autopilot_origin and related_type='renewal' and related_id is not null;
-- Historical card payload/source IDs are not trusted origin receipts. Keep legacy rows manager-only.
-- Live read guard uses ordinary caller card RLS, never a privileged public oracle.
drop policy if exists family_reminders_origin_read on public.family_reminders;
create policy family_reminders_origin_read on public.family_reminders as restrictive for select to authenticated using(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=family_reminders.autopilot_card_id and c.family_id=family_reminders.family_id and c.action_type='create_reminder')));
drop policy if exists family_reminders_origin_write on public.family_reminders;
create policy family_reminders_origin_write on public.family_reminders as restrictive for update to authenticated using(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=family_reminders.autopilot_card_id and c.family_id=family_reminders.family_id and c.action_type='create_reminder'))) with check(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=family_reminders.autopilot_card_id and c.family_id=family_reminders.family_id and c.action_type='create_reminder')));
drop policy if exists reminders_origin_read on public.reminders;
create policy reminders_origin_read on public.reminders as restrictive for select to authenticated using(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=reminders.autopilot_card_id and c.family_id=reminders.family_id and c.action_type='create_reminder')));
drop policy if exists reminders_origin_write on public.reminders;
create policy reminders_origin_write on public.reminders as restrictive for update to authenticated using(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=reminders.autopilot_card_id and c.family_id=reminders.family_id and c.action_type='create_reminder'))) with check(auth.uid() is not null and public.is_family_member(family_id) and(not autopilot_origin or public.can_manage_family(family_id) or exists(select 1 from public.autopilot_suggestions c where c.id=reminders.autopilot_card_id and c.family_id=reminders.family_id and c.action_type='create_reminder')));
create or replace function reminder_origin_private.guard_origin() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare card public.autopilot_suggestions; old_tags text[]; new_tags text[]; actor uuid := auth.uid(); service boolean := current_setting('role',true) is not distinct from 'service_role';
begin
 if TG_OP='UPDATE' then
  if row(new.family_id,new.autopilot_origin,new.autopilot_card_id) is distinct from row(old.family_id,old.autopilot_origin,old.autopilot_card_id) then raise exception 'Reminder origin is immutable' using errcode='42501'; end if;
  if old.autopilot_origin then
   if TG_TABLE_NAME='family_reminders' then
    select coalesce(array_agg(t order by t),'{}') into old_tags from unnest(old.tags) t where t ~ '^autopilot-source:[a-f0-9]{64}$';
    select coalesce(array_agg(t order by t),'{}') into new_tags from unnest(new.tags) t where t ~ '^autopilot-source:[a-f0-9]{64}$';
    if old.idempotency_key is distinct from new.idempotency_key or old_tags is distinct from new_tags then raise exception 'Reminder stamps are immutable' using errcode='42501'; end if;
   elsif row(old.related_type,old.related_id) is distinct from row(new.related_type,new.related_id) then raise exception 'Reminder source is immutable' using errcode='42501'; end if;
  end if;
 else
  if TG_TABLE_NAME='family_reminders' then
   if exists(select 1 from unnest(new.tags) t where t ~ '^autopilot-source:[a-f0-9]{64}$') then new.autopilot_origin:=true; end if;
  elsif new.related_type='renewal' and new.related_id is not null then new.autopilot_origin:=true; end if;
  if new.autopilot_card_id is not null then new.autopilot_origin:=true; end if;
 end if;
 if new.autopilot_origin then
  if not service then perform 1 from public.family_members where family_id=new.family_id and user_id=actor and is_active for share; if not found then raise exception 'Reminder actor changed' using errcode='42501'; end if; end if;
  if new.autopilot_card_id is not null then
   select * into card from public.autopilot_suggestions c where c.id=new.autopilot_card_id and c.family_id=new.family_id and c.action_type='create_reminder' for share;
  end if;
  if not service and not public.can_manage_family(new.family_id) and(card.id is null or not reminder_origin_private.card_readable(card,actor)) then raise exception 'Reminder source unavailable' using errcode='42501'; end if;
  if TG_OP='INSERT' and new.autopilot_card_id is not null and card.id is null then raise exception 'Reminder source unavailable' using errcode='42501'; end if;
 end if;
 return new;
end $$;
revoke all on function reminder_origin_private.guard_origin() from public,anon,authenticated,service_role;
drop trigger if exists family_reminders_guard_origin on public.family_reminders;
create trigger family_reminders_guard_origin before insert or update on public.family_reminders for each row execute function reminder_origin_private.guard_origin();
drop trigger if exists reminders_guard_origin on public.reminders;
create trigger reminders_guard_origin before insert or update on public.reminders for each row execute function reminder_origin_private.guard_origin();
create or replace function public.create_card_family_reminder(p_card_id uuid,p_expected_updated_at timestamptz,p_at timestamptz,p_source_tag text)
returns setof public.family_reminders language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.autopilot_suggestions; r public.family_reminders; actor uuid:=auth.uid(); key text;
begin
 if actor is null or p_at is null then raise exception 'Reminder source unavailable' using errcode='42501'; end if;
 select * into c from public.autopilot_suggestions where id=p_card_id for share;
 if c.id is null or c.action_type is distinct from 'create_reminder' or c.kind='policy' or not reminder_origin_private.card_readable(c,actor) then raise exception 'Reminder source unavailable' using errcode='42501'; end if;
 perform 1 from public.family_members where family_id=c.family_id and user_id=actor and is_active for share; if not found then raise exception 'Reminder actor changed' using errcode='42501'; end if;
 if c.member_id is not null then
  perform 1 from public.family_members where id=c.member_id and family_id=c.family_id and is_active for share;
  if not found then raise exception 'Reminder recipient changed' using errcode='40001'; end if;
 end if;
 if p_source_tag is null or p_source_tag !~ '^autopilot-source:[a-f0-9]{64}$' then raise exception 'Invalid informational stamp' using errcode='22023'; end if;
 key:=reminder_origin_private.card_key(c.family_id,c.id);
 select * into r from public.family_reminders where family_id=c.family_id and idempotency_key=key;
 if r.id is not null then
  if not r.autopilot_origin or r.autopilot_card_id is distinct from c.id or not(p_source_tag=any(r.tags)) or c.status not in ('open','executed') then raise exception 'Reminder receipt changed' using errcode='40001'; end if;
  return next r; return;
 end if;
 if c.status is distinct from 'open' or c.updated_at is distinct from p_expected_updated_at then raise exception 'Reminder source changed' using errcode='40001'; end if;
 if c.expires_at is not null and c.expires_at<=now() then raise exception 'Reminder source expired' using errcode='40001'; end if;
 if p_at<=now() then raise exception 'Reminder time expired' using errcode='40001'; end if;
 insert into public.family_reminders(family_id,created_by,title,notes,remind_at,member_id,priority,ai_suggested,tags,idempotency_key,autopilot_origin,autopilot_card_id)
 values(c.family_id,actor,coalesce(c.payload->>'title',c.title),c.detail,p_at,case when c.kind='insurance' or c.source_kind='family_insurance_policies' then null else c.member_id end,case when c.urgency>=3 then 'high' else 'medium' end,true,array[p_source_tag],key,true,c.id)
 on conflict(family_id,idempotency_key) where idempotency_key is not null do nothing;
 select * into r from public.family_reminders where family_id=c.family_id and idempotency_key=key;
 if r.id is null or not r.autopilot_origin or r.autopilot_card_id is distinct from c.id or not(p_source_tag=any(r.tags)) then raise exception 'Reminder source changed' using errcode='40001'; end if;
 return next r;
end $$;
revoke all on function public.create_card_family_reminder(uuid,timestamptz,timestamptz,text) from public,anon,service_role;
grant execute on function public.create_card_family_reminder(uuid,timestamptz,timestamptz,text) to authenticated;
-- Atomic scan writer: source card and legacy copy publish in one transaction.
create or replace function reminder_origin_private.scan_copy(p_card jsonb,p_at timestamptz,p_actor uuid,p_service boolean) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.autopilot_suggestions; r public.reminders; fam uuid := (p_card->>'family_id')::uuid;
begin
 if fam is null or p_at is null or p_card->>'action_type' is distinct from 'create_reminder' then raise exception 'Invalid card reminder' using errcode='22023'; end if;
 if not exists(select 1 from public.families where id=fam) then raise exception 'Invalid family' using errcode='42501'; end if;
 if not p_service and(p_actor is null or not exists(select 1 from public.family_members where user_id=p_actor and family_id=fam and is_active)) then raise exception 'Invalid actor' using errcode='42501'; end if;
 if p_service and p_actor is not null and not exists(select 1 from public.family_members where user_id=p_actor and family_id=fam and is_active) then raise exception 'Invalid actor' using errcode='42501'; end if;
 if p_actor is not null then perform 1 from public.family_members where family_id=fam and user_id=p_actor and is_active for share; if not found then raise exception 'Invalid actor' using errcode='42501'; end if; end if;
 c:=jsonb_populate_record(null::public.autopilot_suggestions,p_card);
 if c.member_id is not null then perform 1 from public.family_members where id=c.member_id and family_id=fam and is_active for share; if not found then raise exception 'Invalid reminder recipient' using errcode='42501'; end if; end if;
 if c.expires_at is not null and c.expires_at<=now() then raise exception 'Reminder source expired' using errcode='40001'; end if;
 if not p_service and not reminder_origin_private.card_readable(c,p_actor) then raise exception 'Reminder source unavailable' using errcode='42501'; end if;
 insert into public.autopilot_suggestions(family_id,member_id,kind,title,detail,confidence,urgency,status,action_type,action_label,payload,source_kind,source_id,dedupe_key,expires_at,resolved_at,resolved_by,created_by)
 values(c.family_id,c.member_id,c.kind,c.title,c.detail,c.confidence,c.urgency,'open',c.action_type,c.action_label,c.payload,c.source_kind,c.source_id,c.dedupe_key,c.expires_at,null,null,p_actor) returning * into c;
 insert into public.reminders(family_id,title,notes,remind_at,member_id,related_type,related_id,created_by,autopilot_origin,autopilot_card_id)
 values(fam,coalesce(c.payload->>'title',c.title),c.detail,p_at,case when c.kind='insurance' or c.source_kind='family_insurance_policies' then null else c.member_id end,case when c.source_kind='appointments' then 'appointment' when c.source_kind='calendar_events' then 'event' else 'renewal' end,c.source_id,p_actor,true,c.id) returning * into r;
 update public.autopilot_suggestions set status='auto_executed',resolved_at=now(),payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{reminder_id}',to_jsonb(r.id::text),true) where id=c.id;
 return jsonb_build_object('card_id',c.id,'reminder_id',r.id,'family_id',fam);
end $$;
revoke all on function reminder_origin_private.scan_copy(jsonb,timestamptz,uuid,boolean) from public,anon,authenticated,service_role;
create or replace function public.create_card_legacy_reminder(p_card jsonb,p_at timestamptz) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is null then raise exception 'Invalid actor' using errcode='42501'; end if;
 return reminder_origin_private.scan_copy(p_card,p_at,auth.uid(),false);
end $$;
revoke all on function public.create_card_legacy_reminder(jsonb,timestamptz) from public,anon,service_role;
grant execute on function public.create_card_legacy_reminder(jsonb,timestamptz) to authenticated;
create or replace function public.create_card_legacy_reminder_service(p_card jsonb,p_at timestamptz,p_actor uuid default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Invalid service actor' using errcode='42501'; end if;
 return reminder_origin_private.scan_copy(p_card,p_at,p_actor,true);
end $$;
revoke all on function public.create_card_legacy_reminder_service(jsonb,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.create_card_legacy_reminder_service(jsonb,timestamptz,uuid) to service_role;
create or replace function public.repeat_card_family_reminder(p_parent_id uuid,p_at timestamptz) returns setof public.family_reminders language plpgsql security definer set search_path=pg_catalog,public as $$
declare parent public.family_reminders; receipt public.family_reminders; c public.autopilot_suggestions; next_row public.family_reminders; key text; actor uuid:=auth.uid();
begin
 if actor is null or p_at is null then raise exception 'Invalid recurrence actor' using errcode='42501'; end if;
 select * into parent from public.family_reminders where id=p_parent_id for update;
 if parent.id is null or not public.is_family_member(parent.family_id) or parent.status is distinct from 'completed' or not parent.autopilot_origin then raise exception 'Recurrence unavailable' using errcode='42501'; end if;
 perform 1 from public.family_members where family_id=parent.family_id and user_id=actor and is_active for share; if not found then raise exception 'Recurrence actor changed' using errcode='42501'; end if;
 select * into c from public.autopilot_suggestions where id=parent.autopilot_card_id and family_id=parent.family_id and action_type='create_reminder' for share;
 if not public.can_manage_family(parent.family_id) and(c.id is null or not reminder_origin_private.card_readable(c,actor)) then raise exception 'Recurrence unavailable' using errcode='42501'; end if;
 key:=encode(extensions.digest('autopilot.repeat:'||parent.id::text,'sha256'),'hex');
 next_row:=jsonb_populate_record(null::public.family_reminders,to_jsonb(parent)||(case when jsonb_typeof(to_jsonb(parent)->'subtasks')='array' then jsonb_build_object('subtasks',(select coalesce(jsonb_agg(x||jsonb_build_object('done',false)),'[]'::jsonb) from jsonb_array_elements(to_jsonb(parent)->'subtasks') x)) else '{}'::jsonb end)||jsonb_build_object('id',gen_random_uuid(),'idempotency_key',key,'created_by',actor,'created_at',now(),'updated_at',now(),'remind_at',p_at,'status','active','completed_at',null,'snoozed_until',null));
 insert into public.family_reminders select next_row.* on conflict(family_id,idempotency_key) where idempotency_key is not null do nothing;
 select * into receipt from public.family_reminders where family_id=parent.family_id and idempotency_key=key;
 if receipt.id is null or not receipt.autopilot_origin or receipt.autopilot_card_id is distinct from parent.autopilot_card_id or receipt.tags is distinct from parent.tags then raise exception 'Recurrence identity changed' using errcode='40001'; end if;
 return next receipt;
end $$;
revoke all on function public.repeat_card_family_reminder(uuid,timestamptz) from public,anon,service_role;
grant execute on function public.repeat_card_family_reminder(uuid,timestamptz) to authenticated;
-- INVOKER admission checks the caller before the definer authority guard.
create or replace function public.require_trusted_reminder_origin() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare generated boolean:=new.autopilot_origin or new.autopilot_card_id is not null; table_owner name;
begin
 if TG_TABLE_NAME='family_reminders' then generated:=generated or exists(select 1 from unnest((jsonb_populate_record(NULL::public.family_reminders,to_jsonb(NEW))).tags) t where t~'^autopilot-source:[a-f0-9]{64}$');
 else generated:=generated or((jsonb_populate_record(NULL::public.reminders,to_jsonb(NEW))).related_type='renewal'and (jsonb_populate_record(NULL::public.reminders,to_jsonb(NEW))).related_id is not null); end if;
 if generated then
  select pg_get_userbyid(c.relowner) into table_owner from pg_catalog.pg_class c where c.oid=TG_RELID;
  if current_user is distinct from table_owner then raise exception 'Trusted reminder creation required' using errcode='42501'; end if;
 end if;
 return new;
end $$;
revoke all on function public.require_trusted_reminder_origin() from public,anon,authenticated,service_role;
drop trigger if exists aa_require_trusted_origin on public.family_reminders;
create trigger aa_require_trusted_origin before insert on public.family_reminders for each row execute function public.require_trusted_reminder_origin();
drop trigger if exists aa_require_trusted_origin on public.reminders;
create trigger aa_require_trusted_origin before insert on public.reminders for each row execute function public.require_trusted_reminder_origin();

COMMIT;
