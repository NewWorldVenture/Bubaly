-- Family Messenger: private participants, durable identity and atomic RPCs.
-- Privileged helpers are outside the exposed schema; public RPCs are invokers.
create schema if not exists messaging_private;
revoke all on schema messaging_private from public, anon;
grant usage on schema messaging_private to authenticated, service_role;
alter table public.family_conversations add column if not exists is_family_chat boolean not null default false;
alter table public.family_messages add column if not exists edited_at timestamptz;
alter table public.family_messages add column if not exists idempotency_key text;
create unique index if not exists family_one_canonical_chat on public.family_conversations(family_id) where is_family_chat;
create unique index if not exists family_message_operation_once
  on public.family_messages(family_id, sender_id, idempotency_key) nulls not distinct where idempotency_key is not null;
create index if not exists family_messages_history_cursor
  on public.family_messages(conversation_id, created_at desc, id desc) where deleted_at is null;

-- Legacy names and current rosters do not authorize exposing old history to
-- future household members. Preserve every existing conversation and its
-- participant scope. The normal ensure_family_conversation RPC creates a new,
-- empty canonical chat; an explicitly flagged canonical chat survives reapply.

create or replace function messaging_private.can_access_conversation(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.family_conversations c
    join public.family_members m on m.family_id = c.family_id and m.user_id = auth.uid() and m.is_active
    where c.id = p_id and (c.is_family_chat
      or (cardinality(c.participant_ids) > 0 and m.id = any(c.participant_ids))
      or (cardinality(c.participant_ids) = 0 and auth.uid() = any(c.member_ids))
      or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0 and c.created_by = auth.uid()))
  );
$$;
revoke all on function messaging_private.can_access_conversation(uuid) from public, anon;
grant execute on function messaging_private.can_access_conversation(uuid) to authenticated, service_role;
create or replace function public.can_access_family_conversation(p_conversation_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select messaging_private.can_access_conversation(p_conversation_id);
$$;
revoke all on function public.can_access_family_conversation(uuid) from public, anon;
grant execute on function public.can_access_family_conversation(uuid) to authenticated, service_role;

create or replace function messaging_private.conversation_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; users uuid[]; remaining uuid[]; self_leave boolean := false;
begin
  if tg_op = 'UPDATE' then
    -- A privileged leave RPC may remove only the caller (and already inactive
    -- members), never add/remove another active participant. No client-set GUC
    -- or mutable session flag bypasses this check.
    if auth.uid() is not null and not old.is_family_chat and old.kind <> 'direct'
      and messaging_private.can_access_conversation(old.id) then
      select coalesce(array_agg(m.id order by m.id), '{}') into remaining from public.family_members m
        where m.family_id = old.family_id and m.is_active and m.user_id is distinct from auth.uid()
          and ((cardinality(old.participant_ids) > 0 and m.id = any(old.participant_ids))
            or (cardinality(old.participant_ids) = 0 and m.user_id = any(old.member_ids)));
      self_leave := cardinality(remaining) > 0 and new.participant_ids @> remaining and new.participant_ids <@ remaining
        and exists (select 1 from public.family_members m where m.id = any(remaining) and m.user_id is not null);
    end if;
    if auth.uid() is not null and (new.id is distinct from old.id or new.family_id is distinct from old.family_id
      or (new.created_by is distinct from old.created_by and not (self_leave and old.created_by = auth.uid()
        and exists (select 1 from public.family_members m where m.id = any(remaining) and m.user_id = new.created_by)))
      or new.kind is distinct from old.kind
      or new.is_family_chat is distinct from old.is_family_chat) then
      raise exception 'Conversation identity cannot change' using errcode = '42501';
    end if;
    if new.participant_ids is not distinct from old.participant_ids and new.member_ids is not distinct from old.member_ids then return new; end if;
    if old.kind = 'direct' then raise exception 'Start a new direct conversation to change participants' using errcode = '42501'; end if;
  end if;
  if new.is_family_chat then
    select coalesce(array_agg(m.id order by m.id), '{}'),
      coalesce(array_agg(distinct m.user_id) filter (where m.user_id is not null), '{}') into ids, users
      from public.family_members m where m.family_id = new.family_id and m.is_active;
  else
    if cardinality(new.participant_ids) > 0 then
      select array_agg(distinct x order by x) into ids from unnest(new.participant_ids) x;
      if exists (select 1 from unnest(ids) x where x is null or not exists (
        select 1 from public.family_members m where m.id = x and m.family_id = new.family_id and m.is_active)) then
        raise exception 'Choose active members of this household' using errcode = '23514';
      end if;
    else
      if exists (select 1 from unnest(new.member_ids) x where x is null or not exists (
        select 1 from public.family_members m where m.user_id = x and m.family_id = new.family_id and m.is_active)) then
        raise exception 'Choose active members of this household' using errcode = '23514';
      end if;
      select coalesce(array_agg(m.id order by m.id), '{}') into ids from public.family_members m
        where m.family_id = new.family_id and m.is_active and (m.user_id = any(new.member_ids) or m.user_id = new.created_by);
    end if;
    if cardinality(ids) = 0 or (new.kind = 'direct' and cardinality(ids) <> 2) then
      raise exception 'A direct conversation needs two participants; a group needs at least one' using errcode = '23514';
    end if;
    if auth.uid() is not null and not self_leave and not exists (select 1 from public.family_members m
      where m.id = any(ids) and m.family_id = new.family_id and m.user_id = auth.uid() and m.is_active) then
      raise exception 'The caller must be a participant' using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct m.user_id) filter (where m.user_id is not null), '{}') into users
      from public.family_members m where m.id = any(ids);
  end if;
  new.participant_ids := ids; new.member_ids := users; new.updated_at := now();
  return new;
end;
$$;
revoke all on function messaging_private.conversation_guard() from public, anon, authenticated;
drop trigger if exists trg_family_conversation_guard on public.family_conversations;
create trigger trg_family_conversation_guard before insert or update on public.family_conversations
  for each row execute function messaging_private.conversation_guard();

-- Only the canonical RPC assigns is_family_chat. Table grants would override
-- column restrictions, so replace them rather than merely revoking columns.
revoke all on public.family_conversations from anon, authenticated;
grant select, delete on public.family_conversations to authenticated;
grant insert (id, family_id, name, kind, avatar_emoji, member_ids, participant_ids, created_by, description, is_archived)
  on public.family_conversations to authenticated;
grant update (name, avatar_emoji, description, is_archived, member_ids, participant_ids) on public.family_conversations to authenticated;
grant all on public.family_conversations to service_role;
alter table public.family_conversations enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'family_conversations' and permissive = 'PERMISSIVE' loop
    execute format('drop policy %I on public.family_conversations', p.policyname);
  end loop;
end $$;
create policy family_conversations_select on public.family_conversations for select to authenticated
  -- Evaluate NEW's roster directly: a stable same-table lookup cannot see an
  -- INSERT's row yet when PostgreSQL evaluates INSERT ... RETURNING policies.
  using (exists (select 1 from public.family_members m where m.family_id = family_conversations.family_id
    and m.user_id = auth.uid() and m.is_active and (is_family_chat
      or (cardinality(participant_ids) > 0 and m.id = any(participant_ids))
      or (cardinality(participant_ids) = 0 and auth.uid() = any(member_ids))
      or (cardinality(participant_ids) = 0 and cardinality(member_ids) = 0 and created_by = auth.uid()))));
create policy family_conversations_insert on public.family_conversations for insert to authenticated
  with check (public.is_family_member(family_id) and created_by = auth.uid() and not is_family_chat);
create policy family_conversations_update on public.family_conversations for update to authenticated
  using (messaging_private.can_access_conversation(id) and ((not is_family_chat and created_by = auth.uid()) or public.can_manage_family(family_id)))
  with check (messaging_private.can_access_conversation(id) and ((not is_family_chat and created_by = auth.uid()) or public.can_manage_family(family_id)));
create policy family_conversations_delete on public.family_conversations for delete to authenticated
  using (not is_family_chat and messaging_private.can_access_conversation(id) and (created_by = auth.uid() or public.can_manage_family(family_id)));

create or replace function messaging_private.ensure_family_conversation(p_family_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if not public.is_family_member(p_family_id) and coalesce(current_setting('role', true), '') <> 'service_role' and session_user <> 'service_role' then
    raise exception 'An active household membership is required' using errcode = '42501';
  end if;
  insert into public.family_conversations(family_id, name, kind, avatar_emoji, created_by, is_family_chat)
    values(p_family_id, 'Family Chat', 'group', '👨‍👩‍👧‍👦', auth.uid(), true)
    on conflict (family_id) where is_family_chat do update set updated_at = public.family_conversations.updated_at
    returning id into result;
  return result;
end;
$$;
revoke all on function messaging_private.ensure_family_conversation(uuid) from public, anon;
grant execute on function messaging_private.ensure_family_conversation(uuid) to authenticated, service_role;
create or replace function public.ensure_family_conversation(p_family_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select messaging_private.ensure_family_conversation(p_family_id);
$$;
revoke all on function public.ensure_family_conversation(uuid) from public, anon;
grant execute on function public.ensure_family_conversation(uuid) to authenticated, service_role;

create or replace function public.create_family_conversation(
  p_family_id uuid, p_participant_ids uuid[], p_name text default null, p_kind text default 'group', p_avatar_emoji text default '💬'
)
returns public.family_conversations language plpgsql security invoker set search_path = '' as $$
declare ids uuid[]; result public.family_conversations;
begin
  if auth.uid() is null or not public.is_family_member(p_family_id) then raise exception 'An active household membership is required' using errcode = '42501'; end if;
  if p_kind not in ('direct', 'group', 'announcement', 'channel') or p_kind is null then raise exception 'Choose a supported conversation kind' using errcode = '22023'; end if;
  if length(coalesce(p_name, '')) > 120 or length(coalesce(p_avatar_emoji, '')) > 32 then raise exception 'Conversation details are too long' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into ids from unnest(p_participant_ids) x;
  -- Validate before the deduplication fast path as well as on INSERT.
  if cardinality(ids) = 0 or (p_kind = 'direct' and cardinality(ids) <> 2)
    or exists (select 1 from unnest(ids) x where x is null or not exists (
      select 1 from public.family_members m where m.id = x and m.family_id = p_family_id and m.is_active)) then
    raise exception 'Choose active household participants; a direct conversation needs two' using errcode = '23514';
  end if;
  if not exists (select 1 from public.family_members m where m.id = any(ids) and m.family_id = p_family_id
    and m.user_id = auth.uid() and m.is_active) then
    raise exception 'The caller must be a participant' using errcode = '42501';
  end if;
  if p_kind = 'direct' then
    perform pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || array_to_string(ids, ','), 475));
    select c.* into result from public.family_conversations c where c.family_id = p_family_id and c.kind = 'direct' and (
      (c.participant_ids @> ids and c.participant_ids <@ ids)
      or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 2 and cardinality(ids) = 2
        and not exists (select 1 from unnest(ids) x where not exists (
          select 1 from public.family_members m where m.id = x and m.user_id = any(c.member_ids) and m.family_id = p_family_id and m.is_active))))
      order by c.created_at, c.id limit 1;
    if found then return result; end if;
  end if;
  insert into public.family_conversations(family_id, name, kind, avatar_emoji, participant_ids, created_by)
    values(p_family_id, nullif(btrim(p_name), ''), p_kind, p_avatar_emoji, ids, auth.uid()) returning * into result;
  return result;
end;
$$;
revoke all on function public.create_family_conversation(uuid, uuid[], text, text, text) from public, anon;
grant execute on function public.create_family_conversation(uuid, uuid[], text, text, text) to authenticated;

create or replace function messaging_private.leave_family_conversation(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.family_conversations; ids uuid[]; users uuid[]; next_creator uuid;
begin
  select * into c from public.family_conversations where id = p_conversation_id for update;
  if not found or not messaging_private.can_access_conversation(c.id) then
    raise exception 'Conversation unavailable' using errcode = '42501';
  end if;
  if c.is_family_chat or c.kind = 'direct' then
    raise exception 'Only a private group can be left; mute family or direct conversations instead' using errcode = '42501';
  end if;
  select coalesce(array_agg(m.id order by m.id), '{}'),
    coalesce(array_agg(distinct m.user_id) filter (where m.user_id is not null), '{}') into ids, users
    from public.family_members m where m.family_id = c.family_id and m.is_active and m.user_id is distinct from auth.uid()
      and ((cardinality(c.participant_ids) > 0 and m.id = any(c.participant_ids))
        or (cardinality(c.participant_ids) = 0 and m.user_id = any(c.member_ids)));
  if cardinality(users) = 0 then
    raise exception 'Another account participant must remain; archive this group instead' using errcode = '42501';
  end if;
  next_creator := c.created_by;
  if c.created_by = auth.uid() then
    select m.user_id into next_creator from public.family_members m where m.id = any(ids) and m.user_id is not null
      order by case m.role when 'parent' then 0 when 'adult' then 1 else 2 end, m.id limit 1;
  end if;
  update public.family_conversations set participant_ids = ids, member_ids = users, created_by = next_creator where id = c.id;
end;
$$;
revoke all on function messaging_private.leave_family_conversation(uuid) from public, anon;
grant execute on function messaging_private.leave_family_conversation(uuid) to authenticated;
create or replace function public.leave_family_conversation(p_conversation_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select messaging_private.leave_family_conversation(p_conversation_id);
$$;
revoke all on function public.leave_family_conversation(uuid) from public, anon;
grant execute on function public.leave_family_conversation(uuid) to authenticated;

create or replace function messaging_private.attachment_path(p_reference text)
returns text language sql immutable set search_path = '' as $$
  select case when p_reference ~ '^[0-9a-fA-F-]{36}/' then split_part(p_reference, '?', 1)
    else substring(p_reference from '/storage/v1/object/(?:public|sign|authenticated)/family-media/([^?]+)') end;
$$;
revoke all on function messaging_private.attachment_path(text) from public, anon;
grant execute on function messaging_private.attachment_path(text) to authenticated, service_role;

create or replace function messaging_private.message_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.family_conversations; parent public.family_messages; path text; m public.family_members;
begin
  if auth.uid() is not null and tg_op = 'UPDATE' then
    -- Every authenticated message mutation (content, receipts, reactions, and
    -- pins) must serialize with membership removal, not only a new send. Use
    -- OLD.family_id because authenticated writers cannot move messages between
    -- households; the sender guard below independently normalizes identity.
    if new.family_id is distinct from old.family_id or new.conversation_id is distinct from old.conversation_id then
      raise exception 'A message cannot move between households or conversations' using errcode = '42501';
    end if;
    select fm.* into m from public.family_members fm
      where fm.family_id = old.family_id and fm.user_id = auth.uid() and fm.is_active
      order by fm.id limit 1 for share of fm;
    if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
  end if;
  select * into c from public.family_conversations where id = new.conversation_id;
  if not found or c.family_id <> new.family_id then raise exception 'A message must belong to its conversation household' using errcode = '23514'; end if;
  if tg_op = 'INSERT' and c.is_archived then raise exception 'Unarchive this conversation before sending a message' using errcode = '42501'; end if;
  if new.reply_to_id is not null and (tg_op = 'INSERT' or new.reply_to_id is distinct from old.reply_to_id) then
    select * into parent from public.family_messages where id = new.reply_to_id;
    if not found or parent.conversation_id <> new.conversation_id or parent.family_id <> new.family_id or parent.deleted_at is not null then
      raise exception 'Reply to a message in this conversation' using errcode = '23514';
    end if;
  end if;
  if auth.uid() is not null and (tg_op = 'INSERT' or new.sender_name is distinct from old.sender_name or new.sender_avatar is distinct from old.sender_avatar) then
    -- FOR SHARE conflicts with the FOR NO KEY UPDATE lock taken by an
    -- is_active update. A send that wins this lock is ordered before removal;
    -- a removal that commits first makes this lookup recheck and reject.
    select fm.* into m from public.family_members fm
      where fm.family_id = new.family_id and fm.user_id = new.sender_id and fm.is_active
      order by fm.id limit 1 for share of fm;
    if not found then raise exception 'The sender must be an active household member' using errcode = '42501'; end if;
    new.sender_name := m.display_name; new.sender_avatar := m.avatar_url;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then raise exception 'A message identity cannot change' using errcode = '42501'; end if;
    if new.idempotency_key is distinct from old.idempotency_key then raise exception 'A message operation key cannot change' using errcode = '42501'; end if;
    new.edited_at := case when new.content is distinct from old.content then now() else old.edited_at end;
  else new.edited_at := null; end if;
  if length(coalesce(new.content, '')) > 4000 or length(coalesce(new.idempotency_key, '')) > 200 then
    raise exception 'Message or operation key is too long' using errcode = '22023';
  end if;
  if new.attachment_url is not null and (tg_op = 'INSERT' or new.attachment_url is distinct from old.attachment_url) then
    path := messaging_private.attachment_path(new.attachment_url);
    if path is not null then
      if new.sender_id is null or path not like new.family_id::text || '/messages/' || new.conversation_id::text || '/' || new.sender_id::text || '/%'
        or cardinality(string_to_array(path, '/')) <> 5 then
        raise exception 'Upload attachments into this conversation and sender folder' using errcode = '23514';
      end if;
    elsif new.attachment_url !~ '^https?://' then raise exception 'Use an uploaded attachment or a web image' using errcode = '23514'; end if;
  end if;
  return new;
end;
$$;
revoke all on function messaging_private.message_guard() from public, anon, authenticated;
drop trigger if exists trg_family_message_integrity on public.family_messages;
create trigger trg_family_message_integrity before insert or update on public.family_messages
  for each row execute function messaging_private.message_guard();
-- Existing sender and per-person read/reaction triggers (0367, 0463) stay active.
create or replace function messaging_private.message_delete_membership_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  -- Preserve server-side deletion behavior. Authenticated hard deletes need the
  -- same ordering guarantee as updates; there is no UPDATE trigger on DELETE.
  -- Family deletion is serialized by its parent guard below; once its row is
  -- gone, cascading child deletes must finish even as memberships cascade too.
  if auth.uid() is null then return old; end if;
  if not exists (select 1 from public.families f where f.id = old.family_id) then return old; end if;
  select fm.* into m from public.family_members fm
    where fm.family_id = old.family_id and fm.user_id = auth.uid() and fm.is_active
    order by fm.id limit 1 for share of fm;
  if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
  return old;
end;
$$;
revoke all on function messaging_private.message_delete_membership_guard() from public, anon, authenticated;
drop trigger if exists trg_family_message_delete_membership_guard on public.family_messages;
create trigger trg_family_message_delete_membership_guard before delete on public.family_messages
  for each row execute function messaging_private.message_delete_membership_guard();

create or replace function messaging_private.conversation_delete_membership_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  if auth.uid() is null then return old; end if;
  -- A family-row cascade is already serialized by family_delete_membership_guard.
  if not exists (select 1 from public.families f where f.id = old.family_id) then return old; end if;
  select fm.* into m from public.family_members fm
    where fm.family_id = old.family_id and fm.user_id = auth.uid() and fm.is_active
    order by fm.id limit 1 for share of fm;
  if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
  return old;
end;
$$;
revoke all on function messaging_private.conversation_delete_membership_guard() from public, anon, authenticated;
drop trigger if exists trg_family_conversation_delete_membership_guard on public.family_conversations;
create trigger trg_family_conversation_delete_membership_guard before delete on public.family_conversations
  for each row execute function messaging_private.conversation_delete_membership_guard();

create or replace function messaging_private.family_delete_membership_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m public.family_members;
begin
  if auth.uid() is null then return old; end if;
  -- A session that bypasses row security — a superuser or a BYPASSRLS role —
  -- acting AS ITSELF, with no SET ROLE in effect, is a maintenance session: the
  -- Database job's probes cleaning up after `reset role`, a replay, an operator
  -- at psql. It is not a member deleting a family through the app, and it may
  -- carry a JWT claim left over from an earlier `set role` in the same session,
  -- so auth.uid() alone cannot tell it apart. The guard is for the app's
  -- callers; `families_delete` already gates them, and this trigger only holds
  -- the admin's membership lock across the cascade. The SAME superuser under
  -- `set role authenticated` is simulating a member — the messaging
  -- verification's sessions do exactly that — and is held to the rule like any
  -- member: the `role` setting reflects SET ROLE even inside this security
  -- definer function, where current_user is the owner and session_user the
  -- connection's role.
  if coalesce(current_setting('role', true), 'none') in ('none', '')
     and exists (select 1 from pg_catalog.pg_roles r where r.rolname = session_user and (r.rolsuper or r.rolbypassrls)) then
    return old;
  end if;
  -- Match families_delete's parent-only is_family_admin policy and retain the
  -- admin's membership lock until every cascading conversation/message delete finishes.
  select fm.* into m from public.family_members fm
    where fm.family_id = old.id and fm.user_id = auth.uid() and fm.role = 'parent' and fm.is_active
    order by fm.id limit 1 for share of fm;
  if not found then raise exception 'An active family admin is required' using errcode = '42501'; end if;
  return old;
end;
$$;
revoke all on function messaging_private.family_delete_membership_guard() from public, anon, authenticated;
drop trigger if exists trg_family_delete_membership_guard on public.families;
create trigger trg_family_delete_membership_guard before delete on public.families
  for each row execute function messaging_private.family_delete_membership_guard();

alter table public.family_messages enable row level security;
revoke all on public.family_messages from anon, authenticated;
grant select, insert, update, delete on public.family_messages to authenticated;
grant all on public.family_messages to service_role;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'family_messages' and permissive = 'PERMISSIVE' loop
    execute format('drop policy %I on public.family_messages', p.policyname);
  end loop;
end $$;
create policy family_messages_select on public.family_messages for select to authenticated
  using (public.is_family_member(family_id) and messaging_private.can_access_conversation(conversation_id));
create policy family_messages_insert on public.family_messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_family_member(family_id) and messaging_private.can_access_conversation(conversation_id));
create policy family_messages_update on public.family_messages for update to authenticated
  using (public.is_family_member(family_id) and messaging_private.can_access_conversation(conversation_id))
  with check (public.is_family_member(family_id) and messaging_private.can_access_conversation(conversation_id));
create policy family_messages_delete on public.family_messages for delete to authenticated
  using (sender_id = auth.uid() and public.is_family_member(family_id) and messaging_private.can_access_conversation(conversation_id));

create or replace function public.toggle_family_message_reaction(p_message_id uuid, p_emoji text)
returns public.family_messages language plpgsql security invoker set search_path = '' as $$
declare result public.family_messages; people jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to react' using errcode = '42501'; end if;
  if p_emoji is null or length(btrim(p_emoji)) not between 1 and 32 then raise exception 'Choose a reaction' using errcode = '22023'; end if;
  select * into result from public.family_messages where id = p_message_id and deleted_at is null for update;
  if not found then raise exception 'Message unavailable' using errcode = '42501'; end if;
  people := coalesce(result.reactions -> p_emoji, '[]'::jsonb);
  if people ? auth.uid()::text then
    select coalesce(jsonb_agg(x), '[]') into people from jsonb_array_elements(people) x where x <> to_jsonb(auth.uid()::text);
  else people := people || to_jsonb(auth.uid()::text); end if;
  update public.family_messages set reactions = case when jsonb_array_length(people) = 0 then reactions - p_emoji
    else jsonb_set(reactions, array[p_emoji], people) end where id = p_message_id returning * into result;
  return result;
end;
$$;
revoke all on function public.toggle_family_message_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_family_message_reaction(uuid, text) to authenticated;

create or replace function public.mark_conversation_read_through(p_conversation_id uuid, p_message_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare boundary public.family_messages; affected integer;
begin
  if auth.uid() is null then raise exception 'Sign in to mark messages read' using errcode = '42501'; end if;
  select * into boundary from public.family_messages where id = p_message_id and conversation_id = p_conversation_id and deleted_at is null;
  if not found then raise exception 'Message unavailable' using errcode = '42501'; end if;
  update public.family_messages set read_by = array_append(read_by, auth.uid()) where conversation_id = p_conversation_id and deleted_at is null
    and (created_at, id) <= (boundary.created_at, boundary.id) and not (read_by @> array[auth.uid()]);
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.mark_conversation_read_through(uuid, uuid) from public, anon;
grant execute on function public.mark_conversation_read_through(uuid, uuid) to authenticated;

create or replace function public.family_conversation_overview(p_family_id uuid)
returns table(conversation_id uuid, last_message jsonb, unread_count bigint)
language sql stable security invoker set search_path = '' as $$
  select c.id, latest.message, (select count(*) from public.family_messages m where m.conversation_id = c.id and m.deleted_at is null
    and m.sender_id is distinct from auth.uid() and not (m.read_by @> array[auth.uid()]))
  from public.family_conversations c left join lateral (
    select to_jsonb(m) as message from public.family_messages m where m.conversation_id = c.id and m.deleted_at is null
    order by m.created_at desc, m.id desc limit 1
  ) latest on true where c.family_id = p_family_id;
$$;
revoke all on function public.family_conversation_overview(uuid) from public, anon;
grant execute on function public.family_conversation_overview(uuid) to authenticated;

-- Legacy URLs remain readable through an authorized message; future uploads
-- identify their conversation + sender so an upload can precede its message.
create or replace function messaging_private.media_access(p_name text, p_write boolean default false)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare parts text[] := string_to_array(p_name, '/'); fam uuid; conv uuid;
begin
  if auth.uid() is null or parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  fam := parts[1]::uuid;
  if not public.is_family_member(fam) then return false; end if;
  if parts[2] is distinct from 'messages' then return true; end if;
  if cardinality(parts) = 5 and parts[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    conv := parts[3]::uuid;
    return messaging_private.can_access_conversation(conv)
      and exists (select 1 from public.family_conversations c where c.id = conv and c.family_id = fam)
      and (parts[4] = auth.uid()::text or (not p_write and exists (
        select 1 from public.family_messages m where m.conversation_id = conv and m.family_id = fam and m.deleted_at is null
          and messaging_private.attachment_path(m.attachment_url) = p_name)));
  end if;
  return exists (select 1 from public.family_messages m where m.family_id = fam
    and messaging_private.attachment_path(m.attachment_url) = p_name and messaging_private.can_access_conversation(m.conversation_id)
    and (case when p_write then m.sender_id = auth.uid() else m.deleted_at is null end));
end;
$$;
revoke all on function messaging_private.media_access(text, boolean) from public, anon;
grant execute on function messaging_private.media_access(text, boolean) to authenticated, service_role;
drop policy if exists "Family members can read their media" on storage.objects;
drop policy if exists "Family members can upload their media" on storage.objects;
drop policy if exists "Family members can update their media" on storage.objects;
drop policy if exists "Family members can delete their media" on storage.objects;
create policy "Family members can read their media" on storage.objects for select to authenticated
  using (bucket_id = 'family-media' and messaging_private.media_access(name, false));
create policy "Family members can upload their media" on storage.objects for insert to authenticated
  with check (bucket_id = 'family-media' and messaging_private.media_access(name, true));
create policy "Family members can update their media" on storage.objects for update to authenticated
  using (bucket_id = 'family-media' and messaging_private.media_access(name, true))
  with check (bucket_id = 'family-media' and messaging_private.media_access(name, true));
create policy "Family members can delete their media" on storage.objects for delete to authenticated
  using (bucket_id = 'family-media' and messaging_private.media_access(name, true));
update storage.buckets set public = false, allowed_mime_types = (select array_agg(distinct t)
  from unnest(coalesce(allowed_mime_types, '{}') || array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav']) t)
  where id = 'family-media';

-- Realtime schema belongs to Supabase. Add policies only, if installed.
create or replace function messaging_private.can_join_topic(p_topic text)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare id_text text;
begin
  if p_topic like 'messages:%' then
    id_text := substring(p_topic from 10);
    if id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return messaging_private.can_access_conversation(id_text::uuid); end if;
  elsif p_topic like 'presence:family:%' then
    id_text := substring(p_topic from 17);
    if id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return public.is_family_member(id_text::uuid); end if;
  end if;
  return false;
end;
$$;
revoke all on function messaging_private.can_join_topic(text) from public, anon;
grant execute on function messaging_private.can_join_topic(text) to authenticated;
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists family_messenger_presence_read on realtime.messages';
    execute 'drop policy if exists family_messenger_presence_write on realtime.messages';
    execute $p$create policy family_messenger_presence_read on realtime.messages for select to authenticated
      using (extension in ('broadcast', 'presence') and messaging_private.can_join_topic((select realtime.topic())))$p$;
    execute $p$create policy family_messenger_presence_write on realtime.messages for insert to authenticated
      with check (extension in ('broadcast', 'presence') and messaging_private.can_join_topic((select realtime.topic())))$p$;
  end if;
end $$;
