-- Real disposable PostgreSQL roles; no hosted database or Storage service.
\set ON_ERROR_STOP on
begin;
do $$ begin
  if exists(select 1 from public.family_conversations where is_family_chat and family_id in
    ('00000000-0000-4000-8000-0000000055f5','00000000-0000-4000-8000-0000000055f6')) then
    raise exception 'BREACH: legacy name/current roster authorized canonical promotion'; end if;
  if exists(select 1 from canonical_history_fixture.conversations old left join public.family_conversations c on c.id=old.id
    where c.id is null or to_jsonb(c)-'is_family_chat' is distinct from old.original) then
    raise exception 'Legacy conversation, roster or metadata changed during migration'; end if;
  if exists(select 1 from canonical_history_fixture.messages old left join public.family_messages m on m.id=old.id
    where m.id is null or to_jsonb(m)-'edited_at'-'idempotency_key' is distinct from old.original) then
    raise exception 'Legacy message history changed during migration'; end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000004753';
do $$ begin
  if exists(select 1 from public.family_messages where family_id='00000000-0000-4000-8000-0000000055f5') then
    raise exception 'Inactive member reads fixture history'; end if;
end $$;
reset role;
update public.family_members set is_active=true where id='00000000-0000-4000-8000-0000000055a3';
insert into public.family_members(family_id,user_id,display_name,role) values
 ('00000000-0000-4000-8000-0000000055f5','00000000-0000-4000-8000-000000005555','Future member','adult'),
 ('00000000-0000-4000-8000-0000000055f6','00000000-0000-4000-8000-000000005555','Future member','adult');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000004753';
do $$ begin
  if exists(select 1 from public.family_messages where conversation_id='00000000-0000-4000-8000-0000000055c5')
    or exists(select 1 from storage.objects where name='00000000-0000-4000-8000-0000000055f5/messages/private-ab.png')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c5') then
    raise exception 'BREACH: reactivated member reads private subgroup history/media/topic'; end if;
  if not exists(select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000055b6') then
    raise exception 'Control: explicitly invited reactivated member lost legacy history'; end if;
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005555';
do $$ begin
  if exists(select 1 from public.family_messages where family_id in
    ('00000000-0000-4000-8000-0000000055f5','00000000-0000-4000-8000-0000000055f6'))
    or exists(select 1 from storage.objects where name in
      ('00000000-0000-4000-8000-0000000055f5/messages/private-ab.png','00000000-0000-4000-8000-0000000055f6/messages/private-named.png'))
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c5')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c6')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c7')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c8') then
    raise exception 'BREACH: future household member inherits private legacy history/media/topics'; end if;
end $$;
-- An existing household member retains explicit access but does not inherit
-- an empty-roster legacy conversation from its name alone.
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists(select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000055b8')
    or messaging_private.can_join_topic('messages:00000000-0000-4000-8000-0000000055c8') then
    raise exception 'BREACH: noncreator reads empty-roster legacy history/topic'; end if;
  if not exists(select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000055b7') then
    raise exception 'Control: explicit legacy participant lost named Family Chat history'; end if;
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000004751';
do $$ declare canonical uuid; begin
  if (select count(*) from public.family_messages where id in
    ('00000000-0000-4000-8000-0000000055b5','00000000-0000-4000-8000-0000000055b6','00000000-0000-4000-8000-0000000055b7','00000000-0000-4000-8000-0000000055b8')) <> 4 then
    raise exception 'Control: original participant lost legacy messages'; end if;
  if (select count(*) from storage.objects where name in
    ('00000000-0000-4000-8000-0000000055f5/messages/private-ab.png','00000000-0000-4000-8000-0000000055f6/messages/private-named.png')) <> 2 then
    raise exception 'Control: original participant lost private media metadata'; end if;
  canonical := public.ensure_family_conversation('00000000-0000-4000-8000-0000000055f5');
  if canonical in ('00000000-0000-4000-8000-0000000055c5','00000000-0000-4000-8000-0000000055c6')
    or canonical <> public.ensure_family_conversation('00000000-0000-4000-8000-0000000055f5')
    or exists(select 1 from public.family_messages where conversation_id=canonical) then
    raise exception 'Canonical creation reused legacy history or duplicated its identity'; end if;
  insert into public.family_messages(family_id,conversation_id,sender_id,content)
    values('00000000-0000-4000-8000-0000000055f5',canonical,auth.uid(),'New explicitly family-wide message');
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000005555';
do $$ begin
  if (select count(*) from public.family_messages where family_id='00000000-0000-4000-8000-0000000055f5') <> 1
    or not exists(select 1 from public.family_messages where content='New explicitly family-wide message') then
    raise exception 'Control: new member cannot read new explicitly canonical conversation'; end if;
end $$;
reset role;
reset request.jwt.claim.sub;
create table canonical_history_fixture.explicit_canonical as select id,to_jsonb(c) as original from public.family_conversations c
 where family_id='00000000-0000-4000-8000-0000000055f5' and is_family_chat;
\ir ../../supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql
do $$ begin
  if exists(select 1 from canonical_history_fixture.explicit_canonical old left join public.family_conversations c on c.id=old.id
    where c.id is null or to_jsonb(c) is distinct from old.original) then
    raise exception 'Reapply changed the explicitly canonical conversation'; end if;
  if exists(select 1 from canonical_history_fixture.conversations old left join public.family_conversations c on c.id=old.id
    where c.id is null or c.is_family_chat or to_jsonb(c)-'is_family_chat' is distinct from old.original) then
    raise exception 'Reapply changed or promoted a legacy conversation'; end if;
end $$;
-- Exact fixture-owned records only; leave the shared messaging suite unchanged.
delete from storage.objects where bucket_id='family-media' and name in
 ('00000000-0000-4000-8000-0000000055f5/messages/private-ab.png','00000000-0000-4000-8000-0000000055f6/messages/private-named.png');
delete from public.families where id in ('00000000-0000-4000-8000-0000000055f5','00000000-0000-4000-8000-0000000055f6');
delete from auth.users where id='00000000-0000-4000-8000-000000005555';
drop table canonical_history_fixture.explicit_canonical,canonical_history_fixture.messages,canonical_history_fixture.conversations;
drop schema canonical_history_fixture;
commit;
select 'PASS: legacy history preserved, reactivated/future nonparticipants refused, invited members retained, fresh empty canonical identity and explicit canonical reapply preserved' as canonical_history_checks;
