\set ON_ERROR_STOP on
-- Experimental disposable barrier, NOT a migration or production apply procedure.
-- Owner/superuser DDL can disable this barrier and is outside its security boundary.
-- Each install/removal takes bounded exclusive locks, so it may briefly block reads.
do $$ begin
 if current_database()<>'cutover_runtime' or session_user<>'cutover_maint'
    or current_setting('server_version_num')::integer not between 170000 and 179999
    or to_regnamespace('cutover_hold') is not null
 then raise exception 'Refuse unowned or repeated cutover hold fixture'; end if;
end $$;
create schema cutover_hold;
revoke all on schema cutover_hold from public,anon,authenticated,service_role,authenticator,cutover_old_writer;
create table cutover_hold.identity(
 singleton boolean primary key default true check(singleton),
 maintenance_name name not null,
 maintenance_oid oid not null,
 tables text[] not null default '{}'
);
insert into cutover_hold.identity(maintenance_name,maintenance_oid)
 select session_user,oid from pg_roles where rolname=session_user;
revoke all on cutover_hold.identity from public,anon,authenticated,service_role,authenticator,cutover_old_writer;

create function cutover_hold.require_maintenance() returns void
language plpgsql security definer set search_path=pg_catalog,cutover_hold as $$
begin
 if not exists(select 1 from cutover_hold.identity i join pg_roles r
   on r.oid=i.maintenance_oid and r.rolname=i.maintenance_name
   where r.rolname=session_user)
 then raise exception 'Synthetic cutover write hold' using errcode='42501'; end if;
end $$;
create function cutover_hold.guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,cutover_hold as $$
begin
 perform cutover_hold.require_maintenance();
 return null; -- statement trigger: no row result is consumed
end $$;

create function cutover_hold.install(scope text) returns void
language plpgsql security definer set search_path=pg_catalog,cutover_hold as $$
declare targets text[]; relation text; lock_list text;
begin
 perform cutover_hold.require_maintenance();
 if (select cardinality(tables) from cutover_hold.identity)<>0 then
  raise exception 'Hold already installed';
 end if;
 if scope='three-table-negative-control' then
  targets:=array['autopilot_suggestions','family_reminders','reminders'];
 elsif scope='twelve-table-negative-control' then
  targets:=array['autopilot_suggestions','calendar_events','chore_assignments',
   'documents','event_rsvps','family_members','family_reminders','grocery_items',
   'meal_plans','reminders','todo_items','transactions'];
 elsif scope='complete' then
  -- Ten directly affected tables plus four explicit family/source dependencies.
  -- auth.users/reminder_lists FK lifecycle and DDL remain outside this bounded model.
  targets:=array['autopilot_suggestions','calendar_events','chore_assignments',
   'documents','event_rsvps','families','family_insurance_policies','family_members',
   'family_reminders','grocery_items','meal_plans','reminders','todo_items','transactions'];
 else raise exception 'Unknown synthetic hold scope'; end if;
 select string_agg(format('public.%I',v),',' order by v) into lock_list from unnest(targets) v;
 perform set_config('lock_timeout','2s',true);
 execute 'lock table '||lock_list||' in access exclusive mode';
 foreach relation in array targets loop
  execute format('create trigger cutover_statement_hold before insert or update or delete or truncate on public.%I for each statement execute function cutover_hold.guard()',relation);
  execute format('alter table public.%I enable always trigger cutover_statement_hold',relation);
 end loop;
 update cutover_hold.identity set tables=targets;
end $$;

create function cutover_hold.remove() returns void
language plpgsql security definer set search_path=pg_catalog,cutover_hold as $$
declare targets text[]; relation text; lock_list text;
begin
 perform cutover_hold.require_maintenance();
 select tables into targets from cutover_hold.identity;
 if cardinality(targets)=0 then raise exception 'No installed hold'; end if;
 select string_agg(format('public.%I',v),',' order by v) into lock_list from unnest(targets) v;
 perform set_config('lock_timeout','2s',true);
 execute 'lock table '||lock_list||' in access exclusive mode';
 foreach relation in array targets loop
  if not exists(select 1 from pg_trigger t where t.tgrelid=format('public.%I',relation)::regclass
    and t.tgname='cutover_statement_hold' and t.tgenabled='A'
    and t.tgfoid='cutover_hold.guard()'::regprocedure) then
   raise exception 'Hold definition changed';
  end if;
  execute format('drop trigger cutover_statement_hold on public.%I',relation);
 end loop;
 update cutover_hold.identity set tables='{}';
end $$;
revoke all on all functions in schema cutover_hold from public,anon,authenticated,service_role,authenticator,cutover_old_writer;
