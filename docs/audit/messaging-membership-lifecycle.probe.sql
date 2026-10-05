-- Real role probes for leaving, archival, deletion and stale notification/media
-- access. All IDs belong to messaging-legacy-fixture.sql; no external data.
\set ON_ERROR_STOP on
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into public.family_conversations(id, family_id, name, kind, participant_ids, created_by)
values ('00000000-0000-4000-8000-0000000047c9', '00000000-0000-4000-8000-0000000047f1', 'Leave lifecycle', 'group',
  array['00000000-0000-4000-8000-0000000047a1','00000000-0000-4000-8000-0000000047a2','00000000-0000-4000-8000-0000000047a3']::uuid[],
  '00000000-0000-4000-8000-000000004751');
insert into storage.objects(bucket_id, name) values ('family-media',
  '00000000-0000-4000-8000-0000000047f1/messages/00000000-0000-4000-8000-0000000047c9/00000000-0000-4000-8000-000000004751/group.png');
insert into public.family_messages(id, family_id, conversation_id, sender_id, content, attachment_url)
values ('00000000-0000-4000-8000-0000000047b9','00000000-0000-4000-8000-0000000047f1',
  '00000000-0000-4000-8000-0000000047c9','00000000-0000-4000-8000-000000004751','Group history',
  '00000000-0000-4000-8000-0000000047f1/messages/00000000-0000-4000-8000-0000000047c9/00000000-0000-4000-8000-000000004751/group.png');

-- A non-manager participant can leave atomically and immediately loses every
-- current DB-authorized surface, including already-created recipient notices.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004753';
insert into public.family_conversation_preferences(conversation_id, user_id, muted)
values ('00000000-0000-4000-8000-0000000047c9','00000000-0000-4000-8000-000000004753',false);
do $$ begin
  if not exists (select 1 from public.notifications where related_type='family_message'
    and related_id='00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9') then
    raise exception 'Control: invited recipient did not receive group notice'; end if;
  if not exists (select 1 from storage.objects where name like '%/group.png') then
    raise exception 'Control: invited recipient cannot read group attachment'; end if;
end $$;
select public.leave_family_conversation('00000000-0000-4000-8000-0000000047c9');
do $$ declare n integer; begin
  if exists (select 1 from public.family_conversations where id='00000000-0000-4000-8000-0000000047c9')
    or exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b9')
    or exists (select 1 from public.family_conversation_preferences where conversation_id='00000000-0000-4000-8000-0000000047c9')
    or exists (select 1 from storage.objects where name like '%/group.png')
    or exists (select 1 from public.notifications where related_id='00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000047c9') then
    raise exception 'BREACH: leaving retained message, media, preference, notice or private topic access'; end if;
  update public.notifications set is_read=true where related_id='00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BREACH: departed participant can update hidden notice'; end if;
  begin
    perform public.leave_family_conversation('00000000-0000-4000-8000-0000000047c9');
    raise exception 'BREACH: nonparticipant can leave/mutate group';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.notifications(family_id,user_id,type,title,related_type,related_id)
    values ('00000000-0000-4000-8000-0000000047f1','00000000-0000-4000-8000-000000004753','system','Forged chat notice','family_message',
      '00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9');
    raise exception 'BREACH: browser authored a chat delivery notice';
  exception when insufficient_privilege then null; end;
end $$;

-- The creator leaves with explicit ownership transfer to the remaining adult.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
select public.leave_family_conversation('00000000-0000-4000-8000-0000000047c9');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if not exists (select 1 from public.family_conversations where id='00000000-0000-4000-8000-0000000047c9'
    and created_by=auth.uid() and participant_ids=array['00000000-0000-4000-8000-0000000047a2']::uuid[]
    and member_ids=array[auth.uid()]) then raise exception 'Creator leave did not transfer ownership/roster'; end if;
  begin
    perform public.leave_family_conversation('00000000-0000-4000-8000-0000000047c9');
    raise exception 'BREACH: last account participant orphaned a group';
  exception when insufficient_privilege then null; end;
  begin
    perform public.leave_family_conversation('00000000-0000-4000-8000-0000000047c1');
    raise exception 'BREACH: direct roster mutated through leave';
  exception when insufficient_privilege then null; end;
  begin
    perform public.leave_family_conversation(public.ensure_family_conversation('00000000-0000-4000-8000-0000000047f1'));
    raise exception 'BREACH: canonical membership mutated through leave';
  exception when insufficient_privilege then null; end;
end $$;
update public.family_conversations set is_archived=true where id='00000000-0000-4000-8000-0000000047c9';
do $$ begin
  if not exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b9')
    or not exists (select 1 from storage.objects where name like '%/group.png') then
    raise exception 'Archive should preserve remaining participant history'; end if;
  begin
    insert into public.family_messages(family_id,conversation_id,sender_id,content)
    values ('00000000-0000-4000-8000-0000000047f1','00000000-0000-4000-8000-0000000047c9',auth.uid(),'Archived send');
    raise exception 'BREACH: new message accepted in archived conversation';
  exception when insufficient_privilege then null; end;
end $$;
delete from public.family_conversations where id='00000000-0000-4000-8000-0000000047c9';
do $$ begin
  if exists (select 1 from storage.objects where name like '%/group.png')
    or exists (select 1 from public.notifications where related_id='00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9') then
    raise exception 'BREACH: deleted conversation retains live media/notice access'; end if;
end $$;

-- Staged uploads are private to the uploader until a live message references
-- them. Soft/hard deletion revokes fresh recipient access to the attachment.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into storage.objects(bucket_id,name) values ('family-media',
  '00000000-0000-4000-8000-0000000047f1/messages/00000000-0000-4000-8000-0000000047c1/00000000-0000-4000-8000-000000004751/lifecycle.png');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists (select 1 from storage.objects where name like '%/lifecycle.png') then raise exception 'BREACH: unsent upload visible to recipient'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into public.family_messages(id,family_id,conversation_id,sender_id,content,attachment_url)
values ('00000000-0000-4000-8000-0000000047ba','00000000-0000-4000-8000-0000000047f1',
  '00000000-0000-4000-8000-0000000047c1','00000000-0000-4000-8000-000000004751','Attachment lifecycle',
  '00000000-0000-4000-8000-0000000047f1/messages/00000000-0000-4000-8000-0000000047c1/00000000-0000-4000-8000-000000004751/lifecycle.png');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if not exists (select 1 from storage.objects where name like '%/lifecycle.png') then raise exception 'Control: sent attachment unavailable to recipient'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
update public.family_messages set deleted_at=now() where id='00000000-0000-4000-8000-0000000047ba';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists (select 1 from storage.objects where name like '%/lifecycle.png') then raise exception 'BREACH: soft-deleted attachment remains recipient-readable'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
delete from public.family_messages where id='00000000-0000-4000-8000-0000000047ba';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists (select 1 from storage.objects where name like '%/lifecycle.png') then raise exception 'BREACH: hard-deleted attachment remains recipient-readable'; end if;
end $$;

-- Membership deactivation hides a previously-delivered notice immediately.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into public.family_messages(id,family_id,conversation_id,sender_id,content)
values ('00000000-0000-4000-8000-0000000047bb','00000000-0000-4000-8000-0000000047f1',
  '00000000-0000-4000-8000-0000000047c1','00000000-0000-4000-8000-000000004751','Deactivate lifecycle');
reset role;
update public.family_members set is_active=false where id='00000000-0000-4000-8000-0000000047a2';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists (select 1 from public.notifications where related_type='family_message') then
    raise exception 'BREACH: deactivated member retains recipient notices'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from public.notifications where related_id in (
    '00000000-0000-4000-8000-0000000047c9:00000000-0000-4000-8000-0000000047b9',
    '00000000-0000-4000-8000-0000000047c1:00000000-0000-4000-8000-0000000047ba')) then
    raise exception 'Hard-deletion did not physically withdraw all related notices'; end if;
end $$;
rollback;
-- Teardown: the probe ran as simulated members; leave no actor behind for
-- whatever this session runs next.
do $$ begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '', false);
end $$;
\echo 'PASS group leave/ownership, last-member protection, archive history, deletion cleanup, staged media, revoked recipient notices and media'
