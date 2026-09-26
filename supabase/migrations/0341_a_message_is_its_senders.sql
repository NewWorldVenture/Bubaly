-- Bubaly :: 0341 - a family chat message is its sender's
--
-- family_messages had one policy: FOR ALL to anyone in the family, with no
-- WITH CHECK. So a member could post a message as someone else (sender_id and
-- sender_name are just columns - "Mom: you can skip school tomorrow"), rewrite
-- the text of anyone's message after it was read, or delete anyone's.
--
-- Every writer sends as the caller (messages-module, lib/services/messages),
-- and only the sender soft-deletes (messages-module: .eq('sender_id', userId)).
-- Other members legitimately update someone else's message in three ways:
-- reactions, read_by (read receipts) and is_pinned.
--
--   INSERT  sender_id = auth.uid()
--   UPDATE  family members, but a trigger lets anyone other than the sender
--           change only reactions / read_by / is_pinned; nobody changes
--           sender_id, and the service role is unaffected
--   DELETE  the sender (the app soft-deletes; hard delete is the sender's too)
--
-- Pinned by docs/audit/message-sender-check.sql.

create or replace function public.family_message_edit_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then
    return new; -- service role / server-side jobs
  end if;
  if new.sender_id is distinct from old.sender_id
     or new.family_id is distinct from old.family_id
     or new.conversation_id is distinct from old.conversation_id
     or new.created_at is distinct from old.created_at then
    raise exception 'A message''s sender, family and conversation cannot change'
      using errcode = '42501';
  end if;
  if auth.uid() is distinct from old.sender_id and (
       new.content is distinct from old.content
    or new.sender_name is distinct from old.sender_name
    or new.sender_avatar is distinct from old.sender_avatar
    or new.kind is distinct from old.kind
    or new.attachment_url is distinct from old.attachment_url
    or new.attachment_name is distinct from old.attachment_name
    or new.attachment_mime is distinct from old.attachment_mime
    or new.reply_to_id is distinct from old.reply_to_id
    or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Only the sender can change or delete this message'
      using errcode = '42501';
  end if;
  return new;
end
$$;

do $$
declare
  p record;
begin
  if to_regclass('public.family_messages') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'family_messages' loop
    execute format('drop policy %I on public.family_messages', p.policyname);
  end loop;
  create policy family_messages_select on public.family_messages for select to authenticated
    using (public.is_family_member(family_id));
  create policy family_messages_insert on public.family_messages for insert to authenticated
    with check (public.is_family_member(family_id) and sender_id = auth.uid());
  create policy family_messages_update on public.family_messages for update to authenticated
    using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
  create policy family_messages_delete on public.family_messages for delete to authenticated
    using (public.is_family_member(family_id) and sender_id = auth.uid());

  drop trigger if exists trg_family_message_edit_guard on public.family_messages;
  create trigger trg_family_message_edit_guard before update on public.family_messages
    for each row execute function public.family_message_edit_guard();
end
$$;
