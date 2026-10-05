-- Real role/RLS checks, not SQL-text assertions. Run after the legacy fixture
-- and 0475 using scripts/verify-messaging-database.mjs. All users are synthetic.
\set ON_ERROR_STOP on
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';
do $$
declare
  fam uuid := '00000000-0000-4000-8000-0000000047f1';
  other_fam uuid := '00000000-0000-4000-8000-0000000047f2';
  a uuid := '00000000-0000-4000-8000-000000004751';
  b uuid := '00000000-0000-4000-8000-000000004752';
  ma uuid := '00000000-0000-4000-8000-0000000047a1';
  mb uuid := '00000000-0000-4000-8000-0000000047a2';
  mc uuid := '00000000-0000-4000-8000-0000000047a3';
  md uuid := '00000000-0000-4000-8000-0000000047a4';
  dm uuid := '00000000-0000-4000-8000-0000000047c1';
  subgroup uuid := '00000000-0000-4000-8000-0000000047c2';
  inactive_subgroup uuid := '00000000-0000-4000-8000-0000000047c5';
  whole uuid := '00000000-0000-4000-8000-0000000047c3';
  foreign_conv uuid := '00000000-0000-4000-8000-0000000047c4';
  first_msg uuid := '00000000-0000-4000-8000-0000000047b1';
  message public.family_messages; conversation public.family_conversations;
  path text; count_rows integer; canonical uuid;
begin
  if has_table_privilege(current_user, 'public.family_messages', 'TRUNCATE')
    or has_table_privilege(current_user, 'public.family_messages', 'TRIGGER') then
    raise exception 'BREACH: browser retains messaging administration privileges'; end if;
  canonical := public.ensure_family_conversation(fam);
  if canonical in (whole, subgroup, dm) or public.ensure_family_conversation(fam) <> canonical then
    raise exception 'Canonical chat must be newly empty and reused only by its explicit flag'; end if;
  if exists(select 1 from public.family_messages where conversation_id=canonical) then
    raise exception 'Legacy history entered the new canonical chat'; end if;
  if exists(select 1 from public.family_conversations where id = subgroup and is_family_chat) then
    raise exception 'A subgroup with stale whole-family member_ids was promoted to family-wide visibility'; end if;
  -- This branch adopts no existing conversation as the canonical chat, whole
  -- roster or not (0475 here creates a new, empty one); the parent's assertion
  -- that `whole` is promoted does not apply to it. `whole` must stay an ordinary
  -- group with its history and roster intact:
  if exists(select 1 from public.family_conversations where id = whole and is_family_chat) then
    raise exception 'A whole-roster legacy group was promoted to the canonical chat; this branch preserves it as it was'; end if;
  if not exists(select 1 from public.family_conversations where id = whole and not is_archived) then
    raise exception 'The whole-roster legacy group did not survive the migration'; end if;
  if exists(select 1 from public.family_conversations where id = inactive_subgroup and is_family_chat) then
    raise exception 'A roster covering only currently active members was promoted'; end if;
  conversation := public.create_family_conversation(fam, array[ma, mb], 'Duplicate DM', 'direct');
  if conversation.id <> dm then raise exception 'Legacy DM was not reused'; end if;
  conversation := public.create_family_conversation(fam, array[mb, ma], 'Reordered DM', 'direct');
  if conversation.id <> dm then raise exception 'DM ordering created a duplicate'; end if;
  begin
    perform public.create_family_conversation(fam, '{}'::uuid[], 'Empty roster', 'direct');
    raise exception 'BREACH: empty direct roster bypassed deduplication validation';
  exception when check_violation then null; end;
  begin
    perform public.ensure_family_conversation(other_fam);
    raise exception 'BREACH: outsider created another family chat';
  exception when insufficient_privilege then null; end;
  begin
    perform public.create_family_conversation(fam, array[ma, md], 'Cross family', 'direct');
    raise exception 'BREACH: foreign participant accepted';
  exception when check_violation then null; end;
  begin
    perform public.create_family_conversation(fam, array[mb, mc], 'No caller', 'direct');
    raise exception 'BREACH: caller omitted from new chat';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.family_conversations(family_id, created_by, is_family_chat) values(fam, a, true);
    raise exception 'BREACH: browser assigned canonical flag';
  exception when insufficient_privilege then null; end;
  begin
    update public.family_conversations set participant_ids = array[ma, mc] where id = dm;
    raise exception 'BREACH: DM roster changed';
  exception when insufficient_privilege then null; end;
  insert into public.family_messages(family_id, conversation_id, sender_id, sender_name, content, idempotency_key)
    values(fam, dm, a, 'Impersonated Bob', 'Original', 'fixture-operation') returning * into message;
  if message.sender_name <> 'Alice' then raise exception 'Sender display identity was not normalized'; end if;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content, idempotency_key)
      values(fam, dm, a, 'Second send', 'fixture-operation');
    raise exception 'BREACH: operation key duplicated a message';
  exception when unique_violation then null; end;
  update public.family_messages set content = 'Edited' where id = message.id returning * into message;
  if message.edited_at is null then raise exception 'Successful edit has no edited_at'; end if;
  begin
    update public.family_messages set idempotency_key = 'changed-operation' where id = message.id;
    raise exception 'BREACH: operation identity changed';
  exception when insufficient_privilege then null; end;
  begin
    update public.family_messages set family_id = other_fam where id = message.id;
    raise exception 'BREACH: message moved to another household';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content) values(fam, foreign_conv, a, 'Cross family');
    raise exception 'BREACH: message and conversation families disagree';
  exception when check_violation then null; end;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content, reply_to_id)
      values(fam, subgroup, a, 'Cross conversation reply', first_msg);
    raise exception 'BREACH: reply linked outside its conversation';
  exception when check_violation then null; end;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content) values(fam, dm, b, 'Pretending to be Bob');
    raise exception 'BREACH: forged sender accepted';
  exception when insufficient_privilege then null; end;
  perform public.mark_conversation_read_through(dm, first_msg);
  perform public.toggle_family_message_reaction(first_msg, '👍');
  path := fam::text || '/messages/' || dm::text || '/' || a::text || '/fixture.png';
  insert into storage.objects(bucket_id, name) values('family-media', path);
  insert into public.family_messages(family_id, conversation_id, sender_id, kind, attachment_url)
    values(fam, dm, a, 'image', path);
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, kind, attachment_url)
      values(fam, subgroup, a, 'image', path);
    raise exception 'BREACH: private attachment linked into another conversation';
  exception when check_violation then null; end;
  if (select count(*) from storage.objects where bucket_id = 'family-media') <> 3 then
    raise exception 'Sender could not read legacy, new and shared media'; end if;
  perform set_config('realtime.topic', 'messages:' || dm, true);
  insert into realtime.messages(topic, extension, payload) values('messages:' || dm, 'broadcast', '{"typing":true}');
  if not exists(select 1 from realtime.messages where topic = 'messages:' || dm) then raise exception 'Control: participant cannot receive private broadcasts'; end if;
  if not messaging_private.can_join_topic('presence:family:' || fam) then raise exception 'Family presence is unavailable'; end if;
  -- More than the old 400-row scan; all unread rows must count and latest wins.
  insert into public.family_messages(family_id, conversation_id, sender_id, content, created_at)
    select fam, whole, a, 'History ' || n, '2026-01-01'::timestamptz + n * interval '1 second' from generate_series(1, 450) n;
end $$;

-- An inactive account returns after migration. Its old membership row cannot
-- turn an active-only subgroup into a history-visible household conversation.
reset role;
update public.family_members set is_active = true where id = '00000000-0000-4000-8000-0000000047a5';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004755';
do $$ begin
  if exists(select 1 from public.family_conversations where id = '00000000-0000-4000-8000-0000000047c5')
    or exists(select 1 from public.family_messages where conversation_id = '00000000-0000-4000-8000-0000000047c5') then
    raise exception 'BREACH: reactivated member can read old subgroup history'; end if;
  if not exists(select 1 from public.family_conversations where id = '00000000-0000-4000-8000-0000000047c3') then
    raise exception 'Control: a complete-roster family chat did not remain available after reactivation'; end if;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content)
      values ('00000000-0000-4000-8000-0000000047f1', '00000000-0000-4000-8000-0000000047c5', auth.uid(), 'Reactivated outsider');
    raise exception 'BREACH: reactivated member sent into old subgroup';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004751';

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$
declare
  a uuid := '00000000-0000-4000-8000-000000004751'; b uuid := '00000000-0000-4000-8000-000000004752';
  dm uuid := '00000000-0000-4000-8000-0000000047c1'; first_msg uuid := '00000000-0000-4000-8000-0000000047b1';
  second_msg uuid := '00000000-0000-4000-8000-0000000047b2';
  fam uuid := '00000000-0000-4000-8000-0000000047f1'; whole uuid := '00000000-0000-4000-8000-0000000047c3';
  message public.family_messages; overview record; n integer; path text;
begin
  perform public.mark_conversation_read_through(dm, first_msg);
  select * into message from public.family_messages where id = first_msg;
  if not message.read_by @> array[a, b] then raise exception 'Read receipt erased another reader'; end if;
  if exists(select 1 from public.family_messages where id = second_msg and read_by @> array[b]) then
    raise exception 'Read-through marked a later unseen message'; end if;
  message := public.toggle_family_message_reaction(first_msg, '👍');
  if not (message.reactions -> '👍') ?& array[a::text, b::text] then raise exception 'Reaction erased another caller'; end if;
  message := public.toggle_family_message_reaction(first_msg, '👍');
  if (message.reactions -> '👍') ? b::text or not (message.reactions -> '👍') ? a::text then raise exception 'Reaction toggle removed the wrong caller'; end if;
  begin
    update public.family_messages set read_by = array[b] where id = first_msg;
    raise exception 'BREACH: forged receipt replacement accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.family_messages set reactions = '{}' where id = first_msg;
    raise exception 'BREACH: forged reaction replacement accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.family_messages set content = 'Someone else edits' where id = first_msg;
    raise exception 'BREACH: non-sender edited content';
  exception when insufficient_privilege then null; end;
  begin
    update public.family_messages set id = gen_random_uuid() where id = first_msg;
    raise exception 'BREACH: message primary identity changed';
  exception when insufficient_privilege then null; end;
  delete from public.family_messages where id = first_msg;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BREACH: non-sender deleted message'; end if;
  update public.family_messages set is_pinned = true where id = first_msg;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Participant could not pin a message'; end if;
  path := fam::text || '/messages/' || dm::text || '/' || a::text || '/fixture.png';
  update storage.objects set metadata = '{"tampered":true}' where name = path;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BREACH: participant overwrote someone else attachment'; end if;
  delete from storage.objects where name = path;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BREACH: participant deleted someone else attachment'; end if;
  begin
    insert into storage.objects(bucket_id, name) values('family-media', fam::text || '/messages/' || dm::text || '/' || a::text || '/forged.png');
    raise exception 'BREACH: participant uploaded as sender';
  exception when insufficient_privilege then null; end;
  select * into overview from public.family_conversation_overview(fam) where conversation_id = whole;
  if overview.unread_count <> 450 or overview.last_message ->> 'content' <> 'History 450' then
    raise exception 'Overview truncated history/unread: %', row_to_json(overview); end if;
end $$;

-- Casey belongs to the SAME household, but neither private conversation.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004753';
do $$
declare fam uuid := '00000000-0000-4000-8000-0000000047f1'; c uuid := '00000000-0000-4000-8000-000000004753';
  dm uuid := '00000000-0000-4000-8000-0000000047c1'; message uuid := '00000000-0000-4000-8000-0000000047b1'; n integer;
begin
  if exists(select 1 from public.family_conversations where id = dm) or exists(select 1 from public.family_messages where conversation_id = dm) then
    raise exception 'BREACH: same-family nonparticipant can read a DM'; end if;
  if exists(select 1 from public.family_conversations where id = '00000000-0000-4000-8000-0000000047c2') then
    raise exception 'BREACH: stale legacy user roster overrides authoritative participant roster'; end if;
  if exists(select 1 from public.family_conversation_overview(fam) where conversation_id = dm) then
    raise exception 'BREACH: overview leaks DM preview or unread'; end if;
  if exists(select 1 from storage.objects where name like fam::text || '/messages/%') then
    raise exception 'BREACH: legacy/new attachments visible outside conversation'; end if;
  if not exists(select 1 from storage.objects where name = fam::text || '/photos/shared.png') then
    raise exception 'Shared family photos were incorrectly hidden'; end if;
  begin
    insert into public.family_messages(family_id, conversation_id, sender_id, content) values(fam, dm, c, 'Uninvited');
    raise exception 'BREACH: nonparticipant sent to DM';
  exception when insufficient_privilege then null; end;
  begin
    perform public.toggle_family_message_reaction(message, '❤️');
    raise exception 'BREACH: nonparticipant reacted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mark_conversation_read_through(dm, message);
    raise exception 'BREACH: nonparticipant marked DM read';
  exception when insufficient_privilege then null; end;
  update public.family_messages set is_pinned = true where id = message;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'BREACH: nonparticipant pinned'; end if;
  begin
    insert into realtime.messages(topic, extension) values('messages:' || dm, 'presence');
    raise exception 'BREACH: nonparticipant joined private presence';
  exception when insufficient_privilege then null; end;
  if exists(select 1 from realtime.messages where topic = 'messages:' || dm) then raise exception 'BREACH: private realtime events leaked'; end if;
end $$;

-- Cross-household and removed members lose all conversation/media access.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004754';
do $$ begin
  if exists(select 1 from public.family_conversations where family_id = '00000000-0000-4000-8000-0000000047f1')
    or exists(select 1 from public.family_messages where family_id = '00000000-0000-4000-8000-0000000047f1')
    or exists(select 1 from storage.objects) then raise exception 'BREACH: cross-household visibility'; end if;
end $$;
reset role;
update public.family_members set is_active = false where user_id = '00000000-0000-4000-8000-000000004752';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000004752';
do $$ begin
  if exists(select 1 from public.family_conversations) or exists(select 1 from public.family_messages) or exists(select 1 from storage.objects) then
    raise exception 'BREACH: removed member retains access'; end if;
  begin
    perform public.ensure_family_conversation('00000000-0000-4000-8000-0000000047f1');
    raise exception 'BREACH: removed member can ensure chat';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local role service_role;
do $$ begin
  if public.ensure_family_conversation('00000000-0000-4000-8000-0000000047f1') is distinct from
    (select id from public.family_conversations where family_id='00000000-0000-4000-8000-0000000047f1' and is_family_chat) then
    raise exception 'Trusted system actor cannot obtain canonical chat'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
  if has_function_privilege(current_user, 'public.ensure_family_conversation(uuid)', 'EXECUTE') then
    raise exception 'BREACH: anonymous canonical RPC privilege'; end if;
  begin
    perform 1 from public.family_messages;
    raise exception 'BREACH: anonymous messaging SELECT privilege';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
-- Teardown: the probe ran as simulated members; leave no actor behind for
-- whatever this session runs next.
do $$ begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '', false);
end $$;
select 'PASS: participant privacy, canonical/DM identity, message/reply/roster integrity, sender identity, receipts, reactions, edits, operation dedupe, complete overview, storage and private Realtime policies' as messaging_checks;
