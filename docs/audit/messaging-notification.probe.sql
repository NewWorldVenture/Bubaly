-- Run only in the disposable messaging fixture after 0475 and 0476.
\set ON_ERROR_STOP on
begin;
delete from public.notifications where related_type = 'family_message';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into public.family_messages (id, family_id, conversation_id, sender_id, content) values
 ('00000000-0000-4000-8000-000000004761', '00000000-0000-4000-8000-0000000047f1', '00000000-0000-4000-8000-0000000047c1', '00000000-0000-4000-8000-000000004751', 'Secret message never copied to notices');
do $$ begin
  if exists (select 1 from public.notifications where related_type = 'family_message') then
    raise exception 'The sender received a notice or can read the recipient notice';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.notifications where related_type = 'family_message') <> 1 then raise exception 'Wrong private-message recipient count'; end if;
  if not exists (select 1 from public.notifications where related_type = 'family_message'
    and user_id = '00000000-0000-4000-8000-000000004752'
    and related_id = '00000000-0000-4000-8000-0000000047c1:00000000-0000-4000-8000-000000004761'
    and title = 'New message' and body = 'Open your conversation in Bubaly.' and not is_read) then
    raise exception 'Notice leaked private content, lacks deep link, or has wrong recipient';
  end if;
end $$;

-- A same-household nonparticipant cannot create preferences for this DM.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004753';
do $$ begin
  begin
    insert into public.family_conversation_preferences (conversation_id, user_id, muted)
    values ('00000000-0000-4000-8000-0000000047c1','00000000-0000-4000-8000-000000004753',true);
    raise exception 'Nonparticipant preference accepted';
  exception when insufficient_privilege then null; end;
end $$;

-- Mute is persisted for its owner; it withdraws unread notices but does not
-- forge read receipts or change another participant's preference.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
insert into public.family_conversation_preferences (conversation_id, user_id, muted)
values ('00000000-0000-4000-8000-0000000047c1','00000000-0000-4000-8000-000000004752',true)
on conflict (conversation_id,user_id) do update set muted = excluded.muted;
do $$ begin
  if exists (select 1 from public.notifications where related_type = 'family_message') then raise exception 'Mute left unread notices'; end if;
  if exists (select 1 from public.family_messages where id = '00000000-0000-4000-8000-000000004761' and auth.uid() = any(read_by)) then raise exception 'Mute marked a message read'; end if;
  begin
    update public.family_conversation_preferences set user_id = '00000000-0000-4000-8000-000000004751';
    raise exception 'Preference changed owners';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
do $$ begin
  if exists (select 1 from public.family_conversation_preferences) then raise exception 'Someone else can read the mute preference'; end if;
end $$;
insert into public.family_messages (id, family_id, conversation_id, sender_id, content) values
 ('00000000-0000-4000-8000-000000004762', '00000000-0000-4000-8000-0000000047f1', '00000000-0000-4000-8000-0000000047c1', '00000000-0000-4000-8000-000000004751', 'Muted message');
reset role;
do $$ begin
  if exists (select 1 from public.notifications where related_type = 'family_message') then raise exception 'Muted message created a notice'; end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
update public.family_conversation_preferences set muted = false where conversation_id = '00000000-0000-4000-8000-0000000047c1';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
insert into public.family_messages (id, family_id, conversation_id, sender_id, content) values
 ('00000000-0000-4000-8000-000000004763', '00000000-0000-4000-8000-0000000047f1', '00000000-0000-4000-8000-0000000047c1', '00000000-0000-4000-8000-000000004751', 'Unmuted message');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if (select count(*) from public.notifications where related_type = 'family_message' and not is_read) <> 1 then raise exception 'Unmute did not restore notices'; end if;
end $$;
select public.mark_conversation_read_through('00000000-0000-4000-8000-0000000047c1','00000000-0000-4000-8000-000000004763');
do $$ begin
  if exists (select 1 from public.notifications where related_type = 'family_message' and not is_read) then raise exception 'Read-through did not settle the notice'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
update public.family_messages set deleted_at = now() where id = '00000000-0000-4000-8000-000000004763';
reset role;
do $$ begin
  if exists (select 1 from public.notifications where related_type = 'family_message') then raise exception 'Deleted message retained notice'; end if;
end $$;

-- Whole-family delivery includes active participants only, without notifying
-- the sender or the removed child; privacy does not depend on a cached roster.
update public.family_members set is_active = false where id = '00000000-0000-4000-8000-0000000047a3';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
-- Match the client flow: create/resolve the canonical conversation before
-- inserting its message, so the RLS statement snapshot can see that row.
select public.ensure_family_conversation('00000000-0000-4000-8000-0000000047f1') as canonical_chat_id \gset
insert into public.family_messages (id, family_id, conversation_id, sender_id, content) values
 ('00000000-0000-4000-8000-000000004764', '00000000-0000-4000-8000-0000000047f1', :'canonical_chat_id', '00000000-0000-4000-8000-000000004751', 'Family message');
reset role;
do $$ begin
  if (select count(*) from public.notifications where related_type = 'family_message') <> 1 then raise exception 'Whole-family recipients include sender, removed member, or outsider'; end if;
  if exists (select 1 from public.notifications where related_type = 'family_message' and user_id <> '00000000-0000-4000-8000-000000004752') then raise exception 'Wrong whole-family recipient'; end if;
end $$;
rollback;
\echo 'PASS messaging notice recipients, privacy, mute, read, deletion and membership'
