-- Per-person mute and recipient-only in-app notices. Message text and private
-- thread names never enter notifications. External email/push workers exclude
-- related_type='family_message'; enabling outbound chat delivery is separate.
create table if not exists public.family_conversation_preferences (
  conversation_id uuid not null references public.family_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.family_conversation_preferences enable row level security;
revoke all on public.family_conversation_preferences from public, anon, authenticated;
grant select on public.family_conversation_preferences to authenticated;
grant insert (conversation_id, user_id, muted), update (conversation_id, user_id, muted)
  on public.family_conversation_preferences to authenticated;
grant all on public.family_conversation_preferences to service_role;
drop policy if exists conversation_preference_read on public.family_conversation_preferences;
create policy conversation_preference_read on public.family_conversation_preferences for select to authenticated
  using (user_id = auth.uid() and messaging_private.can_access_conversation(conversation_id));
drop policy if exists conversation_preference_insert on public.family_conversation_preferences;
create policy conversation_preference_insert on public.family_conversation_preferences for insert to authenticated
  with check (user_id = auth.uid() and messaging_private.can_access_conversation(conversation_id));
drop policy if exists conversation_preference_update on public.family_conversation_preferences;
create policy conversation_preference_update on public.family_conversation_preferences for update to authenticated
  using (user_id = auth.uid() and messaging_private.can_access_conversation(conversation_id))
  with check (user_id = auth.uid() and messaging_private.can_access_conversation(conversation_id));

create unique index if not exists notification_message_recipient
  on public.notifications (related_id, user_id) where related_type = 'family_message';

-- Recipient ownership alone is not sufficient after removal from a group or
-- household. Recheck the referenced live message at read/update time, so no
-- asynchronous cleanup window keeps obsolete chat notices visible.
create or replace function messaging_private.can_access_message_notice(p_family_id uuid, p_key text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare parts text[] := string_to_array(p_key, ':');
begin
  if cardinality(parts) <> 2 or parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return exists (select 1 from public.family_messages m where m.id = parts[2]::uuid and m.conversation_id = parts[1]::uuid
    and m.family_id = p_family_id and m.deleted_at is null and messaging_private.can_access_conversation(m.conversation_id));
end;
$$;
revoke all on function messaging_private.can_access_message_notice(uuid, text) from public, anon;
grant execute on function messaging_private.can_access_message_notice(uuid, text) to authenticated;
drop policy if exists message_notice_current_access on public.notifications;
create policy message_notice_current_access on public.notifications as restrictive for select to authenticated
  using (related_type is distinct from 'family_message' or messaging_private.can_access_message_notice(family_id, related_id));
drop policy if exists message_notice_current_update on public.notifications;
create policy message_notice_current_update on public.notifications as restrictive for update to authenticated
  using (related_type is distinct from 'family_message' or messaging_private.can_access_message_notice(family_id, related_id))
  with check (related_type is distinct from 'family_message' or messaging_private.can_access_message_notice(family_id, related_id));
drop policy if exists message_notice_server_authorship on public.notifications;
create policy message_notice_server_authorship on public.notifications as restrictive for insert to authenticated
  with check (related_type is distinct from 'family_message');

create or replace function messaging_private.guard_conversation_preference()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.conversation_id is distinct from old.conversation_id or new.user_id is distinct from old.user_id) then
    raise exception 'A conversation preference cannot change owners' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function messaging_private.guard_conversation_preference() from public, anon, authenticated;
drop trigger if exists conversation_preference_guard on public.family_conversation_preferences;
create trigger conversation_preference_guard before insert or update on public.family_conversation_preferences
  for each row execute function messaging_private.guard_conversation_preference();

create or replace function messaging_private.message_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare message_key text;
begin
  if tg_op = 'DELETE' then
    delete from public.notifications where related_type = 'family_message' and related_id = old.conversation_id::text || ':' || old.id::text;
    return old;
  end if;
  message_key := new.conversation_id::text || ':' || new.id::text;
  if tg_op = 'INSERT' then
    if new.deleted_at is not null then return new; end if;
    insert into public.notifications (family_id, user_id, type, title, body, related_type, related_id)
    select distinct new.family_id, m.user_id, 'system'::public.notification_type,
      'New message', 'Open your conversation in Bubaly.', 'family_message', message_key
    from public.family_conversations c
    join public.family_members m on m.family_id = c.family_id and m.is_active and m.user_id is not null
    left join public.family_conversation_preferences p on p.conversation_id = c.id and p.user_id = m.user_id
    where c.id = new.conversation_id and c.family_id = new.family_id
      and m.user_id is distinct from new.sender_id
      and not (m.user_id = any(coalesce(new.read_by, '{}'::uuid[])))
      and not coalesce(p.muted, false)
      and (c.is_family_chat
        or (cardinality(c.participant_ids) > 0 and m.id = any(c.participant_ids))
        or (cardinality(c.participant_ids) = 0 and m.user_id = any(c.member_ids))
        or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0 and c.created_by = m.user_id))
    on conflict (related_id, user_id) where related_type = 'family_message' do nothing;
  elsif new.deleted_at is not null then
    delete from public.notifications where related_type = 'family_message' and related_id = message_key;
  elsif new.read_by is distinct from old.read_by then
    update public.notifications set is_read = true
    where related_type = 'family_message' and related_id = message_key
      and user_id = any(coalesce(new.read_by, '{}'::uuid[])) and not is_read;
  end if;
  return new;
end;
$$;
revoke all on function messaging_private.message_notifications() from public, anon, authenticated;
drop trigger if exists message_recipient_notifications on public.family_messages;
create trigger message_recipient_notifications after insert or delete or update of read_by, deleted_at on public.family_messages
  for each row execute function messaging_private.message_notifications();

create or replace function messaging_private.mute_conversation_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.muted then
    delete from public.notifications where related_type = 'family_message' and user_id = new.user_id
      and split_part(related_id, ':', 1) = new.conversation_id::text and not is_read;
  end if;
  return new;
end;
$$;
revoke all on function messaging_private.mute_conversation_notifications() from public, anon, authenticated;
drop trigger if exists conversation_mute_notifications on public.family_conversation_preferences;
create trigger conversation_mute_notifications after insert or update of muted on public.family_conversation_preferences
  for each row execute function messaging_private.mute_conversation_notifications();
