\set ON_ERROR_STOP on
\if :{?skip_guard}
\else
\set skip_guard false
\endif
-- The test runner supplies baseline_sql containing exact approval table/column
-- and policy blocks from main 0093, 0251 and 0255. Only synthetic dependency
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
create table public.ai_requests(id uuid primary key);
create table public.ai_plan_steps(id uuid primary key);
create table public.family_automation_runs(id uuid primary key);
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
grant select on public.family_members to authenticated;
\i :baseline_sql
alter table public.approval_requests enable row level security;
grant select,insert,update,delete on public.approval_requests to authenticated;
grant select on public.approval_requests to anon;
grant all on public.approval_requests,public.family_members to service_role;

create schema fixture;
create function fixture.assert_true(p_condition boolean,p_label text) returns void
language plpgsql set search_path='' as $$ begin
  if p_condition is distinct from true then raise exception 'FAIL: %',p_label; end if;
end $$;
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
insert into public.approval_requests(id,family_id,domain,requested_by_kind,requested_by_member_id,title,summary,payload,consequences) values
 ('ad000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000001','messaging','ai','ab000000-0000-4000-8000-000000000004','Private synthetic draft','PRIVATE SYNTHETIC DRAFT',
  '{"name":"messages.sendFamilyMessage","args":{"content":"PRIVATE SYNTHETIC DRAFT","conversation_id":"ae000000-0000-4000-8000-000000000001"}}','["PRIVATE SYNTHETIC DRAFT"]'),
 ('ad000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000001','messaging','member','ab000000-0000-4000-8000-000000000004','Own member request',null,'{}','[]'),
 ('ad000000-0000-4000-8000-000000000003','aa000000-0000-4000-8000-000000000001','messaging','member','ac000000-0000-4000-8000-000000000004','Sibling own request',null,'{}','[]'),
 ('ad000000-0000-4000-8000-000000000004','aa000000-0000-4000-8000-000000000001','messaging','ai',null,'Ownerless system approval',null,'{}','[]'),
 ('ad000000-0000-4000-8000-000000000005','aa000000-0000-4000-8000-000000000001','messaging','member','ab000000-0000-4000-8000-000000000007','Same-ID requester',null,'{}','[]'),
 ('ad000000-0000-4000-8000-000000000006','aa000000-0000-4000-8000-000000000001','messaging','member','ab000000-0000-4000-8000-000000000004','Different owner behind colliding ID',null,'{}','[]'),
 ('ad000000-0000-4000-8000-000000000007','aa000000-0000-4000-8000-000000000001','messaging','ai','ac000000-0000-4000-8000-000000000007','Wrong family requester stamp',null,'{}','[]');

set local role authenticated;
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000004',true);
select fixture.assert_true((select count(*) from public.approval_requests where id='ad000000-0000-4000-8000-000000000001')=1,
 'old family-wide policy reproduces private draft exposure');
reset role;
\if :skip_guard
\else
\ir ../../supabase/reserved/0492_approval_requests_private_read.sql
\ir ../../supabase/reserved/0492_approval_requests_private_read.sql
\endif
set local role authenticated;
select fixture.assert_true((select count(*) from public.approval_requests where id='ad000000-0000-4000-8000-000000000001')=0,
 'unrelated child cannot read private draft');
select fixture.assert_true((select count(*) from public.approval_requests)=1,'sibling sees only own approval');
select fixture.assert_true((select count(*) from public.approval_requests where id='ad000000-0000-4000-8000-000000000006')=0,
 'member UUID collision does not grant another account ownership');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000003',true);
select fixture.assert_true((select count(*) from public.approval_requests)=3,'active requester sees own AI/member and mapped collision requests');
select fixture.assert_true((select count(*) from public.approval_requests where id='ad000000-0000-4000-8000-000000000007')=0,
 'other-family membership does not authorize wrong family stamp');
select fixture.assert_true((select payload->'args'->>'content' from public.approval_requests where id='ad000000-0000-4000-8000-000000000001')='PRIVATE SYNTHETIC DRAFT',
 'requester retains actual private approval fields');
-- A browser .insert(...).select() needs the new SELECT rule as well as main's
-- existing INSERT rule. Prove it under the real requester, then restore seeds.
do $$ declare inserted_id uuid; begin
  begin
    insert into public.approval_requests(id,family_id,domain,requested_by_kind,requested_by_member_id,title)
      values('ad000000-0000-4000-8000-000000000008','aa000000-0000-4000-8000-000000000001','messaging',
        'member','ab000000-0000-4000-8000-000000000004','New own synthetic request') returning id into inserted_id;
    perform fixture.assert_true(inserted_id='ad000000-0000-4000-8000-000000000008','requester INSERT RETURNING stays allowed');
    raise exception 'restore synthetic insert' using errcode='ZX002';
  exception when sqlstate 'ZX002' then null;
  end;
end $$;
update public.approval_requests set status='cancelled' where id='ad000000-0000-4000-8000-000000000002';
select fixture.assert_true((select status from public.approval_requests where id='ad000000-0000-4000-8000-000000000002')='cancelled',
 'requester can still cancel own pending approval');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000007',true);
select fixture.assert_true((select count(*) from public.approval_requests)=1,'same member/user ID keeps legitimate requester access');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000005',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'foreign parent cannot read this household approvals');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000006',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'inactive parent cannot review');
select set_config('request.jwt.claim.sub','',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'null authenticated actor cannot read');
set local role anon;
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000001',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'anon cannot impersonate manager with a UID claim');
set local role authenticated;
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000001',true);
select fixture.assert_true((select count(*) from public.approval_requests)=7,'active parent retains all household reviews including system');
update public.approval_requests set status='approved' where id='ad000000-0000-4000-8000-000000000004';
select fixture.assert_true((select status from public.approval_requests where id='ad000000-0000-4000-8000-000000000004')='approved',
 'parent can still decide ownerless system approval');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000002',true);
select fixture.assert_true((select count(*) from public.approval_requests)=7,'active adult retains review visibility');
update public.approval_requests set status='rejected' where id='ad000000-0000-4000-8000-000000000001';
select fixture.assert_true((select status from public.approval_requests where id='ad000000-0000-4000-8000-000000000001')='rejected',
 'adult can still decide requester approval');
reset role;
-- Existing restrictive restrictions must AND with the new policy.
create policy fixture_existing_read_guard on public.approval_requests as restrictive for select to authenticated
  using(id <> 'ad000000-0000-4000-8000-000000000004'::uuid);
set local role authenticated;
select fixture.assert_true((select count(*) from public.approval_requests where id='ad000000-0000-4000-8000-000000000004')=0,
 'inherited restrictive policy remains effective for a reviewer');
reset role;
drop policy fixture_existing_read_guard on public.approval_requests;
update public.family_members set is_active=false where user_id='ab000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000003',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'deactivated requester loses every approval copy');
reset role;
update public.family_members set is_active=false where user_id='ab000000-0000-4000-8000-000000000001';
update public.family_members set role='child' where user_id='ab000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000001',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'revoked manager loses private approval copies');
select set_config('request.jwt.claim.sub','ab000000-0000-4000-8000-000000000002',true);
select fixture.assert_true((select count(*) from public.approval_requests)=0,'demoted reviewer loses unrelated approval copies');
set local role service_role;
select set_config('request.jwt.claim.sub','',true);
select fixture.assert_true((select count(*) from public.approval_requests)=7,'service execution retains ledger access');
reset role;
select 'approval private read: actual-role ownership, review, revocation and inherited restriction assertions PASS' as result;
rollback;
