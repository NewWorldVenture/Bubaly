\set ON_ERROR_STOP on
\if :{?skip_guard}
\else
\set skip_guard false
\endif
\if :{?old_inactive}
\else
\set old_inactive false
\endif
-- The runner supplies exact relevant AI/approval DDL and effective policies
-- from main 0022, 0093, 0250, 0251, 0255 and 0264. Only synthetic dependency
-- tables are modeled here. Run in a new disposable database; the first CREATE
-- aborts before any source migration can touch a preexisting application DB.
begin;
create table public.families(id uuid primary key);
create schema auth;
create table auth.users(id uuid primary key);
create table public.family_members(
  id uuid primary key, family_id uuid not null references public.families(id),
  user_id uuid references auth.users(id), role text not null, is_active boolean not null default true,
  unique(family_id,user_id)
);
create table public.trust_policies(id uuid primary key);
do $$ begin
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create function auth.uid() returns uuid language sql stable set search_path='' as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
create function public.is_family_member(p_family_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.family_members where family_id=p_family_id and user_id=auth.uid() and is_active);
$$;
create function public.can_manage_family(p_family_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.family_members where family_id=p_family_id and user_id=auth.uid()
    and role in('parent','adult') and is_active);
$$;
alter table public.family_members enable row level security;
create policy members_read on public.family_members for select to authenticated using(public.is_family_member(family_id));
grant usage on schema public,auth to authenticated,anon,service_role;
grant execute on all functions in schema public,auth to authenticated,anon,service_role;
-- Supabase may grant these roles directly through default privileges.
alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
grant select on public.family_members to authenticated;
create table public.ai_conversations(id uuid primary key);
create table public.ai_messages(id uuid primary key);
create table public.family_automation_rules(id uuid primary key);
\i :baseline_sql
do $$ declare t text; begin
 foreach t in array array['ai_requests','ai_request_context','ai_plans','ai_plan_steps','ai_run_events','ai_tool_calls','family_automation_runs','approval_requests'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant insert on public.ai_requests to authenticated;
grant select,insert,update,delete on public.approval_requests to authenticated;
create schema fixture;
create function fixture.assert_true(p_condition boolean,p_label text) returns void language plpgsql set search_path='' as $$ begin
 if p_condition is distinct from true then raise exception 'FAIL: %',p_label; end if;
 perform set_config('fixture.passed_assertions',(coalesce(nullif(current_setting('fixture.passed_assertions',true),''),'0')::integer+1)::text,true);
end $$;
create table fixture.ids(name text primary key,id uuid not null);
create function fixture.id(p_name text) returns uuid language sql stable security definer set search_path='' as $$ select id from fixture.ids where name=p_name; $$;
grant usage on schema fixture to authenticated,anon,service_role;
grant execute on all functions in schema fixture to authenticated,anon,service_role;
insert into public.families values('aa000000-0000-4000-8000-000000000001'),('aa000000-0000-4000-8000-000000000002');
insert into auth.users select ('ab000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,7) n;
insert into public.family_members(id,family_id,user_id,role,is_active) values
 ('ac000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000001','parent',true),
 ('ac000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000002','adult',true),
 -- Collision: requester #3's sole member ID equals sibling #4's user ID.
 ('ab000000-0000-4000-8000-000000000004','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000003','child',true),
 ('ac000000-0000-4000-8000-000000000004','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000004','child',true),
 ('ac000000-0000-4000-8000-000000000005','aa000000-0000-4000-8000-000000000002','ab000000-0000-4000-8000-000000000005','parent',true),
 ('ac000000-0000-4000-8000-000000000006','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000006','parent',false),
 -- A supported account whose member ID happens to equal its user ID.
 ('ab000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000007','guest',true),
 -- The requester is also active in the other family. A wrong family stamp
 -- must not treat their other-family member ID as ownership in this family.
 ('ac000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000002','ab000000-0000-4000-8000-000000000003','child',true);
insert into fixture.ids values ('family','aa000000-0000-4000-8000-000000000001'),('other-family','aa000000-0000-4000-8000-000000000002'),('alice','ab000000-0000-4000-8000-000000000003'),('eve','ab000000-0000-4000-8000-000000000004'),('parent','ab000000-0000-4000-8000-000000000001'),('adult','ab000000-0000-4000-8000-000000000002'),('cross','ab000000-0000-4000-8000-000000000005'),('alice-member','ab000000-0000-4000-8000-000000000004'),('eve-member','ac000000-0000-4000-8000-000000000004'),('parent-member','ac000000-0000-4000-8000-000000000001');
insert into fixture.ids values ('mixed','ae000000-0000-4000-8000-000000000001');
insert into public.ai_requests(id,family_id,requested_by,request_text,clarifications) values('af000000-0000-4000-8000-000000000001', fixture.id('family'), fixture.id('alice'), 'Send PRIVATE SYNTHETIC 779 ONLY ALICE BOB to the private mixed chat', '[]');
insert into public.ai_request_context(request_id,family_id,snapshot) values('af000000-0000-4000-8000-000000000001', fixture.id('family'), '{"private_message":"PRIVATE SYNTHETIC 779 ONLY ALICE BOB"}');
insert into public.ai_plans(id,family_id,request_id,objective) values('af000000-0000-4000-8000-000000000002', fixture.id('family'), 'af000000-0000-4000-8000-000000000001', 'Send PRIVATE SYNTHETIC 779 ONLY ALICE BOB');
insert into public.ai_plan_steps(id,family_id,plan_id,tool_name,input_json,result_json) values('af000000-0000-4000-8000-000000000003', fixture.id('family'), 'af000000-0000-4000-8000-000000000002', 'messages.sendFamilyMessage', jsonb_build_object('conversation_id', fixture.id('mixed'), 'content','PRIVATE SYNTHETIC 779 ONLY ALICE BOB'), '{"summary":"Sent to the family chat: PRIVATE SYNTHETIC 779 ONLY ALICE BOB"}');
insert into public.family_automation_runs(id,family_id,request_id,plan_id,summary) values('af000000-0000-4000-8000-000000000006', fixture.id('family'), 'af000000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000002', 'Send PRIVATE SYNTHETIC 779 ONLY ALICE BOB');
insert into public.ai_run_events(id,family_id,request_id,run_id,message,event_type) values('af000000-0000-4000-8000-000000000004', fixture.id('family'), 'af000000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000006', 'Sent to the family chat: PRIVATE SYNTHETIC 779 ONLY ALICE BOB','step_completed');
insert into public.ai_tool_calls(id,family_id,requested_by,tool_name,inputs,outputs,idempotency_key) values('af000000-0000-4000-8000-000000000005', fixture.id('family'), fixture.id('alice'), 'messages.sendFamilyMessage', jsonb_build_object('conversation_id', fixture.id('mixed'), 'content','PRIVATE SYNTHETIC 779 ONLY ALICE BOB'), jsonb_build_object('result',jsonb_build_object('conversation_id',fixture.id('mixed'),'content','PRIVATE SYNTHETIC 779 ONLY ALICE BOB')),'synthetic-af000000-0000-4000-8000-000000000005');
insert into public.approval_requests(id,family_id,requested_by_member_id,payload,summary,consequences,domain,title) values('af000000-0000-4000-8000-000000000007', fixture.id('family'), fixture.id('alice-member'), jsonb_build_object('name','messages.sendFamilyMessage','args',jsonb_build_object('conversation_id',fixture.id('mixed'),'content','PRIVATE SYNTHETIC 779 ONLY ALICE BOB')), 'Everyone in the chat will see PRIVATE SYNTHETIC 779 ONLY ALICE BOB', '["Everyone in the chat will see PRIVATE SYNTHETIC 779 ONLY ALICE BOB"]','messaging','Synthetic approval');

update public.ai_requests set requested_by_member_id=fixture.id('alice-member');
update public.family_automation_runs set requested_by_member_id=fixture.id('alice-member'), created_by=fixture.id('alice');
update public.ai_tool_calls set requested_by_member_id=fixture.id('alice-member'), request_id='af000000-0000-4000-8000-000000000001', run_id='af000000-0000-4000-8000-000000000006', plan_step_id='af000000-0000-4000-8000-000000000003';
\ir ../../supabase/reserved/0492_approval_requests_private_read.sql
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('eve')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=1,'baseline child reads private requester text');
select fixture.assert_true((select count(*) from public.family_automation_runs)=1,'current source unrelated child reads private run summary');
select fixture.assert_true((select count(*) from public.approval_requests)=0,'0477 already denies unrelated approval draft');
reset role;
update public.family_members set is_active=false where id=fixture.id('alice-member');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_tool_calls)=1,'current source deactivated requester keeps raw tool receipt');
reset role;
update public.family_members set is_active=true where id=fixture.id('alice-member');
\if :skip_guard
\else
\ir ../../supabase/reserved/0493_ai_copy_private_read_and_quota.sql
\ir ../../supabase/reserved/0493_ai_copy_private_read_and_quota.sql
\endif
\if :skip_guard
\else
select fixture.assert_true(not has_function_privilege('anon','public.count_family_ai_requests_month(uuid,timestamptz)','execute'),'anon has no quota EXECUTE despite direct default grant');
select fixture.assert_true(not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.count_family_ai_requests_month(uuid,timestamptz)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC has no quota EXECUTE');
select fixture.assert_true(has_function_privilege('authenticated','public.count_family_ai_requests_month(uuid,timestamptz)','execute'),'authenticated retains quota EXECUTE');
select fixture.assert_true(has_function_privilege('service_role','public.count_family_ai_requests_month(uuid,timestamptz)','execute'),'service retains quota EXECUTE');
\endif
\if :old_inactive
update public.family_members set is_active=false where id=fixture.id('alice-member');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_tool_calls)=0,'inactive owner cannot read private tool receipt');
reset role;
rollback;
\quit
\endif
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=1,'active requester retains ai_requests');
select fixture.assert_true((select count(*) from public.ai_request_context)=1,'active requester retains ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=1,'active requester retains ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=1,'active requester retains ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=1,'active requester retains family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=1,'active requester retains ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=1,'active requester retains ai_tool_calls');
select set_config('request.jwt.claim.sub',fixture.id('eve')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=0,'unrelated child cannot read private request');
select fixture.assert_true((select count(*) from public.ai_request_context)=0,'unrelated child loses ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=0,'unrelated child loses ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=0,'unrelated child loses ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=0,'unrelated child loses family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=0,'unrelated child loses ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=0,'unrelated child loses ai_tool_calls');
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=1,'manager retains ai_requests');
select fixture.assert_true((select count(*) from public.ai_request_context)=1,'manager retains ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=1,'manager retains ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=1,'manager retains ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=1,'manager retains family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=1,'manager retains ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=1,'manager retains ai_tool_calls');
reset role;
update public.family_members set is_active=false where id=fixture.id('alice-member');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=0,'deactivated requester loses ai_requests');
select fixture.assert_true((select count(*) from public.ai_request_context)=0,'deactivated requester loses ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=0,'deactivated requester loses ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=0,'deactivated requester loses ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=0,'deactivated requester loses family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=0,'deactivated requester loses ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=0,'deactivated requester loses ai_tool_calls');
reset role;
update public.family_members set is_active=true where id=fixture.id('alice-member');

-- Deny foreign, inactive-manager and null actors across all stored copies.
set local role authenticated;
do $$ declare actor uuid; t text; visible_count bigint; begin
 foreach actor in array array[fixture.id('cross'),'ab000000-0000-4000-8000-000000000006'::uuid,null] loop
  perform set_config('request.jwt.claim.sub',coalesce(actor::text,''),true);
  foreach t in array array['ai_requests','ai_request_context','ai_plans','ai_plan_steps','family_automation_runs','ai_run_events','ai_tool_calls'] loop
   execute format('select count(*) from public.%I',t) into visible_count;
   perform fixture.assert_true(visible_count=0,'foreign/inactive/null actor cannot read '||t);
  end loop;
 end loop;
end $$;
reset role;

-- Ownerless routine/system request, graph, receipt and approval remain manager-readable.
insert into public.ai_requests(id,family_id,requested_by,request_text,clarifications) values('af000000-0000-4000-8000-000000000008',fixture.id('family'),null,'Synthetic ownerless routine','[]');
insert into public.ai_plans(id,family_id,request_id,objective) values('af000000-0000-4000-8000-000000000009',fixture.id('family'),'af000000-0000-4000-8000-000000000008','Synthetic routine objective');
insert into public.family_automation_runs(id,family_id,request_id,plan_id,summary) values('af000000-0000-4000-8000-000000000010',fixture.id('family'),'af000000-0000-4000-8000-000000000008','af000000-0000-4000-8000-000000000009','Synthetic routine summary');
insert into public.ai_plan_steps(id,family_id,plan_id,tool_name,input_json,result_json) values('af000000-0000-4000-8000-000000000011',fixture.id('family'),'af000000-0000-4000-8000-000000000009','messages.sendFamilyMessage','{}','{}');
insert into public.ai_run_events(id,family_id,request_id,run_id,message,event_type) values('af000000-0000-4000-8000-000000000012',fixture.id('family'),'af000000-0000-4000-8000-000000000008','af000000-0000-4000-8000-000000000010','Synthetic routine event','step_completed');
insert into public.ai_tool_calls(id,family_id,tool_name,inputs,outputs,request_id,run_id,plan_step_id,idempotency_key) values('af000000-0000-4000-8000-000000000013',fixture.id('family'),'messages.sendFamilyMessage','{}','{}','af000000-0000-4000-8000-000000000008','af000000-0000-4000-8000-000000000010','af000000-0000-4000-8000-000000000011','synthetic-af000000-0000-4000-8000-000000000013');
insert into public.ai_request_context(request_id,family_id,snapshot) values('af000000-0000-4000-8000-000000000008',fixture.id('family'),'{}');
insert into public.approval_requests(id,family_id,requested_by_member_id,payload,summary,consequences,domain,title) values('af000000-0000-4000-8000-000000000014',fixture.id('family'),null,'{}','Synthetic system approval','[]','messaging','Synthetic approval');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=2,'manager retains ownerless system ai_requests');
select fixture.assert_true((select count(*) from public.ai_request_context)=2,'manager retains ownerless system ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=2,'manager retains ownerless system ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=2,'manager retains ownerless system ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=2,'manager retains ownerless system family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=2,'manager retains ownerless system ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=2,'manager retains ownerless system ai_tool_calls');
select fixture.assert_true((select count(*) from public.approval_requests)=2,'manager retains ownerless system approval_requests');
select set_config('request.jwt.claim.sub',fixture.id('eve')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=0,'unrelated child cannot read ownerless system ai_requests');
select fixture.assert_true((select count(*) from public.ai_request_context)=0,'unrelated child cannot read ownerless system ai_request_context');
select fixture.assert_true((select count(*) from public.ai_plans)=0,'unrelated child cannot read ownerless system ai_plans');
select fixture.assert_true((select count(*) from public.ai_plan_steps)=0,'unrelated child cannot read ownerless system ai_plan_steps');
select fixture.assert_true((select count(*) from public.family_automation_runs)=0,'unrelated child cannot read ownerless system family_automation_runs');
select fixture.assert_true((select count(*) from public.ai_run_events)=0,'unrelated child cannot read ownerless system ai_run_events');
select fixture.assert_true((select count(*) from public.ai_tool_calls)=0,'unrelated child cannot read ownerless system ai_tool_calls');
select fixture.assert_true((select count(*) from public.approval_requests)=0,'unrelated child cannot read ownerless system approval_requests');
reset role;
-- Exact same-family joins reject a row stamped for this family but parented elsewhere.
insert into public.ai_requests(id,family_id,requested_by,request_text,clarifications) values('af000000-0000-4000-8000-000000000015',fixture.id('other-family'),fixture.id('cross'),'Other household private text','[]');
insert into public.ai_plans(id,family_id,request_id,objective) values('af000000-0000-4000-8000-000000000016',fixture.id('family'),'af000000-0000-4000-8000-000000000015','Wrong family parent');
insert into public.ai_request_context(request_id,family_id,snapshot) values('af000000-0000-4000-8000-000000000015',fixture.id('family'),'{}');
insert into public.ai_plans(id,family_id,request_id,objective) values('af000000-0000-4000-8000-000000000060',fixture.id('other-family'),'af000000-0000-4000-8000-000000000015','Foreign plan');
insert into public.family_automation_runs(id,family_id,request_id,plan_id,summary) values('af000000-0000-4000-8000-000000000061',fixture.id('other-family'),'af000000-0000-4000-8000-000000000015','af000000-0000-4000-8000-000000000060','Foreign run');
insert into public.ai_plan_steps(id,family_id,plan_id,tool_name) values('af000000-0000-4000-8000-000000000062',fixture.id('other-family'),'af000000-0000-4000-8000-000000000060','messages.sendFamilyMessage');
insert into public.ai_plan_steps(id,family_id,plan_id,tool_name) values('af000000-0000-4000-8000-000000000063',fixture.id('family'),'af000000-0000-4000-8000-000000000060','messages.sendFamilyMessage');
insert into public.family_automation_runs(id,family_id,request_id,summary) values('af000000-0000-4000-8000-000000000064',fixture.id('family'),'af000000-0000-4000-8000-000000000015','Wrong-family request');
insert into public.ai_run_events(id,family_id,run_id,message,event_type) values('af000000-0000-4000-8000-000000000065',fixture.id('family'),'af000000-0000-4000-8000-000000000061','Wrong-family run','step_completed');
insert into public.ai_tool_calls(id,family_id,requested_by,tool_name,inputs,idempotency_key,request_id,run_id,plan_step_id) values('af000000-0000-4000-8000-000000000066',fixture.id('family'),fixture.id('alice'),'messages.sendFamilyMessage','{}','synthetic-wrong-parent','af000000-0000-4000-8000-000000000015','af000000-0000-4000-8000-000000000061','af000000-0000-4000-8000-000000000062');
insert into public.family_automation_runs(id,family_id,request_id,plan_id,summary) values('af000000-0000-4000-8000-000000000067',fixture.id('family'),'af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000009','Same-family conflicting request/plan');
insert into public.ai_run_events(id,family_id,request_id,run_id,step_id,message,event_type) values('af000000-0000-4000-8000-000000000068',fixture.id('family'),'af000000-0000-4000-8000-000000000008','af000000-0000-4000-8000-000000000006','af000000-0000-4000-8000-000000000011','Conflicting request/step','step_completed');
-- Both sides must be visible: a hidden foreign parent would make the equality
-- controls pass vacuously even if the explicit same-family joins regressed.
insert into public.family_members(id,family_id,user_id,role,is_active) values('ac000000-0000-4000-8000-000000000060',fixture.id('other-family'),fixture.id('parent'),'parent',true);
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests where id='af000000-0000-4000-8000-000000000015')=1,'foreign parent request is visible to dual-household manager');
select fixture.assert_true((select count(*) from public.ai_plans where id='af000000-0000-4000-8000-000000000060')=1,'foreign parent plan is visible to dual-household manager');
select fixture.assert_true((select count(*) from public.family_automation_runs where id='af000000-0000-4000-8000-000000000061')=1,'foreign parent run is visible to dual-household manager');
select fixture.assert_true((select count(*) from public.ai_plan_steps where id='af000000-0000-4000-8000-000000000062')=1,'foreign parent step is visible to dual-household manager');
select fixture.assert_true((select count(*) from public.ai_plans where id='af000000-0000-4000-8000-000000000016')=0,'manager cannot read cross-family parent plan');
select fixture.assert_true((select count(*) from public.ai_request_context where request_id='af000000-0000-4000-8000-000000000015')=0,'manager cannot read cross-family parent context');
select fixture.assert_true((select count(*) from public.ai_plan_steps where id='af000000-0000-4000-8000-000000000063')=0,'manager cannot read cross-family parent step');
select fixture.assert_true((select count(*) from public.family_automation_runs where id in('af000000-0000-4000-8000-000000000064','af000000-0000-4000-8000-000000000067'))=0,'manager cannot read foreign or conflicting run ancestry');
select fixture.assert_true((select count(*) from public.ai_run_events where id in('af000000-0000-4000-8000-000000000065','af000000-0000-4000-8000-000000000068'))=0,'manager cannot read foreign or conflicting event ancestry');
select fixture.assert_true((select count(*) from public.ai_tool_calls where id='af000000-0000-4000-8000-000000000066')=0,'manager cannot read cross-family receipt ancestry');
reset role;
delete from public.family_members where id='ac000000-0000-4000-8000-000000000060';
insert into public.ai_requests(id,family_id,requested_by,requested_by_member_id,request_text,clarifications)
select ('af000000-0000-4000-8000-'||lpad((n+20)::text,12,'0'))::uuid,fixture.id('family'),fixture.id('alice'),fixture.id('alice-member'),'Synthetic sibling usage only','[]' from generate_series(1,9) n;
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('eve')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests)=0,'new request read guard hides siblings from ordinary count');
select fixture.assert_true(public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')=11,'count-only RPC preserves family quota including sibling and ownerless requests');
do $$ begin
  begin
    perform public.count_family_ai_requests_month(fixture.id('other-family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
    raise exception 'foreign quota count wrongly permitted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.count_family_ai_requests_month(fixture.id('family'),now());
    raise exception 'non-month window wrongly permitted';
  exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin
    perform public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
    raise exception 'null quota actor wrongly permitted';
  exception when insufficient_privilege then null; end;
end $$;
-- ACL alone must not be the reason actual anon/JWT impersonation is denied.
reset role;
grant execute on function public.count_family_ai_requests_month(uuid,timestamptz) to anon;
set local role anon;
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
select set_config('request.jwt.claim.role','service_role',true);
do $$ begin
  begin
    perform public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
    raise exception 'anon quota executor wrongly permitted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
revoke execute on function public.count_family_ai_requests_month(uuid,timestamptz) from anon;
set local role service_role;
select set_config('request.jwt.claim.sub','',true);
select fixture.assert_true(public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')=11,'actual trusted service preserves ownerless routine accounting');
reset role;
update public.family_members set is_active=false where id=fixture.id('alice-member');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select set_config('request.jwt.claim.role','service_role',true);
do $$ begin
  begin
    perform public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
    raise exception 'inactive quota actor or JWT role spoof wrongly permitted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.family_members set is_active=true where id=fixture.id('alice-member');
-- Retain actual nullable-user owner forms without accepting a foreign member stamp.
insert into public.ai_requests(id,family_id,requested_by,request_text,clarifications) values('af000000-0000-4000-8000-000000000017',fixture.id('family'),fixture.id('alice'),'Legacy user-only owner','[]');
insert into public.family_automation_runs(id,family_id,created_by,summary) values('af000000-0000-4000-8000-000000000018',fixture.id('family'),fixture.id('alice'),'Legacy creator-owned run');
insert into public.ai_tool_calls(id,family_id,requested_by,tool_name,inputs,idempotency_key) values('af000000-0000-4000-8000-000000000019',fixture.id('family'),fixture.id('alice'),'messages.sendFamilyMessage','{}','synthetic-af000000-0000-4000-8000-000000000019');
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_requests where id='af000000-0000-4000-8000-000000000017')=1,'legacy user-only request stays readable');
select fixture.assert_true((select count(*) from public.family_automation_runs where id='af000000-0000-4000-8000-000000000018')=1,'legacy created-by run stays readable');
select fixture.assert_true((select count(*) from public.ai_tool_calls where id='af000000-0000-4000-8000-000000000019')=1,'standalone user-only tool receipt stays readable');
reset role;

-- A real INSERT RETURNING still passes SELECT for its legitimate requester.
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
with inserted as (
 insert into public.ai_requests(id,family_id,requested_by,requested_by_member_id,request_text)
 values('af000000-0000-4000-8000-000000000040',fixture.id('family'),fixture.id('alice'),fixture.id('alice-member'),'Synthetic own insert') returning id
) select fixture.assert_true((select count(*) from inserted)=1,'requester INSERT RETURNING remains allowed');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub','',true);
insert into public.ai_request_context(request_id,family_id,snapshot)
 values('af000000-0000-4000-8000-000000000040',fixture.id('family'),'{}');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
select fixture.assert_true((select count(*) from public.ai_request_context where request_id='af000000-0000-4000-8000-000000000040')=1,'requester reads service-persisted context for own new request');
reset role;
delete from public.ai_requests where id='af000000-0000-4000-8000-000000000040';
-- Existing requester cancellation and manager/system review rules are unchanged.
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('alice')::text,true);
update public.approval_requests set status='cancelled' where id='af000000-0000-4000-8000-000000000007';
select fixture.assert_true((select status from public.approval_requests where id='af000000-0000-4000-8000-000000000007')='cancelled','requester can still cancel own approval');
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
update public.approval_requests set status='approved' where id='af000000-0000-4000-8000-000000000014';
select fixture.assert_true((select status from public.approval_requests where id='af000000-0000-4000-8000-000000000014')='approved','manager can still decide ownerless system approval');
select set_config('request.jwt.claim.sub',fixture.id('adult')::text,true);
select fixture.assert_true((select count(*) from public.approval_requests)=2,'eligible adult retains both approval review forms');
reset role;
-- AND with an inherited restriction, rather than replacing it with an OR.
create policy fixture_existing_tool_guard on public.ai_tool_calls as restrictive for select to authenticated using(false);
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('parent')::text,true);
select fixture.assert_true((select count(*) from public.ai_tool_calls)=0,'inherited restrictive policy still applies to manager');
reset role;
drop policy fixture_existing_tool_guard on public.ai_tool_calls;
-- Exact lower and upper UTC bounds: adjacent months stay out of this count.
insert into public.ai_requests(id,family_id,requested_by,request_text,created_at) values
 ('af000000-0000-4000-8000-000000000041',fixture.id('family'),fixture.id('alice'),'Before UTC month',(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')-interval '1 microsecond'),
 ('af000000-0000-4000-8000-000000000042',fixture.id('family'),fixture.id('alice'),'At UTC start',date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'),
 ('af000000-0000-4000-8000-000000000043',fixture.id('family'),fixture.id('alice'),'At UTC end',(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC');
set local time zone 'America/New_York';
set local role authenticated;
select set_config('request.jwt.claim.sub',fixture.id('eve')::text,true);
select fixture.assert_true(public.count_family_ai_requests_month(fixture.id('family'),date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')=13,'UTC bounds count exact start and exclude previous/end rows in another session zone');
select fixture.assert_true(public.count_family_ai_requests_month(fixture.id('family'),(date_trunc('month',now() at time zone 'UTC')-interval '1 month') at time zone 'UTC')=1,'previous UTC month contains only its boundary fixture');
select fixture.assert_true(public.count_family_ai_requests_month(fixture.id('family'),(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC')=1,'next UTC month contains only its boundary fixture');
do $$ begin
 begin
  perform public.count_family_ai_requests_month(fixture.id('family'),null);
  raise exception 'null window wrongly accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.count_family_ai_requests_month(fixture.id('family'),'infinity');
  raise exception 'infinite window wrongly accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.count_family_ai_requests_month(null,date_trunc('month',now() at time zone 'UTC') at time zone 'UTC');
  raise exception 'null family wrongly accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'AI copy private read and household quota assertions PASS' as result;
select 'AI copy assertion count: '||current_setting('fixture.passed_assertions') as result;
rollback;
