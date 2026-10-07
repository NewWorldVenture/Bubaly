-- Family Messenger: private participants, durable identity and atomic RPCs.
-- Privileged helpers are outside the exposed schema; public RPCs are invokers.
create schema if not exists messaging_private;
revoke all on schema messaging_private from public, anon;
grant usage on schema messaging_private to authenticated, service_role;
-- Acquire all of the authenticated caller's active family parents in a stable
-- order before any target row. This caller scope also covers users active in
-- multiple families; a cascade must not reach back to an earlier family lock.
create or replace function messaging_private.lock_authenticated_families(p_deleting boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare fam uuid;
begin
  if auth.uid() is null then return; end if;
  if p_deleting then
    for fam in select f.id from public.families f where exists (
      select 1 from public.family_members m where m.family_id = f.id and m.user_id = auth.uid() and m.is_active
    ) order by f.id for update of f loop
      perform 1 from public.family_members m where m.family_id = fam
        and m.user_id = auth.uid() and m.is_active order by m.id for share of m;
    end loop;
  else
    for fam in select f.id from public.families f where exists (
      select 1 from public.family_members m where m.family_id = f.id and m.user_id = auth.uid() and m.is_active
    ) order by f.id for key share of f loop
      perform 1 from public.family_members m where m.family_id = fam
        and m.user_id = auth.uid() and m.is_active order by m.id for share of m;
    end loop;
  end if;
end;
$$;
revoke all on function messaging_private.lock_authenticated_families(boolean) from public, anon, authenticated;

-- FOR SHARE conflicts with deactivation's FOR NO KEY UPDATE. The membership
-- lookup rechecks after waiting: a committed removal cannot admit a late write.
create or replace function messaging_private.lock_actor(p_family_id uuid, p_member_id uuid, p_user_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare actor public.family_members;
begin
  perform messaging_private.lock_authenticated_families();
  -- Family deletion takes the parent row before cascading through memberships.
  -- Follow that order before taking an actor lock, including elevated sends.
  perform 1 from public.families f where f.id = p_family_id for key share of f;
  if not found then raise exception 'Household unavailable' using errcode = '42501'; end if;
  if auth.uid() is not null then
    if p_user_id is distinct from auth.uid() then
      raise exception 'Send only as yourself' using errcode = '42501';
    end if;
  elsif coalesce(current_setting('role', true), '') <> 'service_role' and session_user <> 'service_role' then
    raise exception 'A signed-in member or service executor is required' using errcode = '42501';
  end if;
  if p_user_id is null and p_member_id is null then return 'Bubaly'; end if;
  select m.* into actor from public.family_members m
    where m.id = p_member_id and m.family_id = p_family_id
      and m.user_id = p_user_id and m.is_active for share of m;
  if not found then
    raise exception 'An active household member is required' using errcode = '42501';
  end if;
  return actor.display_name;
end;
$$;
revoke all on function messaging_private.lock_actor(uuid, uuid, uuid) from public, anon;
grant execute on function messaging_private.lock_actor(uuid, uuid, uuid) to authenticated, service_role;

-- A row trigger runs AFTER UPDATE/DELETE has already locked its target. Lock
-- parents before those row locks instead, so a family cascade cannot hold its
-- parent while waiting on a message whose writer waits back on the parent.
create or replace function messaging_private.lock_authenticated_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- DELETE takes exclusive family locks directly, rather than letting two
  -- parent deleters share-lock both families then deadlock on lock upgrades.
  perform messaging_private.lock_authenticated_families(tg_table_name = 'families');
  return null;
end;
$$;
revoke all on function messaging_private.lock_authenticated_scope() from public, anon, authenticated;
drop trigger if exists trg_family_conversation_scope_lock on public.family_conversations;
create trigger trg_family_conversation_scope_lock before insert or update or delete on public.family_conversations
  for each statement execute function messaging_private.lock_authenticated_scope();
drop trigger if exists trg_family_message_scope_lock on public.family_messages;
create trigger trg_family_message_scope_lock before insert or update or delete on public.family_messages
  for each statement execute function messaging_private.lock_authenticated_scope();
drop trigger if exists trg_family_delete_scope_lock on public.families;
create trigger trg_family_delete_scope_lock before delete on public.families
  for each statement execute function messaging_private.lock_authenticated_scope();

-- Membership writes also dirty the household model (0134/0249). Its FK insert
-- needs a family KEY SHARE lock, so ordinary client writes must take family
-- parents before their member row. Do not SHARE-lock the actor here: concurrent
-- self-edits would both need to upgrade that membership lock to a write lock.
-- NOWAIT also makes an externally prelocked membership transaction retry if
-- another transaction already holds the family; ordinary UPDATE-first writers
-- still admit their family before taking any membership row lock.
create or replace function messaging_private.lock_membership_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    perform f.id from public.families f where exists (
      select 1 from public.family_members m
      where m.family_id = f.id and m.user_id = auth.uid() and m.is_active
    ) order by f.id for key share of f nowait;
  end if;
  return null;
exception when lock_not_available then
  raise exception 'Household is changing. Retry the membership change.' using errcode = '55P03';
end;
$$;
revoke all on function messaging_private.lock_membership_scope() from public, anon, authenticated, service_role;

drop trigger if exists trg_family_members_scope_lock on public.family_members;
create trigger trg_family_members_scope_lock before insert or update or delete on public.family_members
  for each statement execute function messaging_private.lock_membership_scope();

-- Service writes and auth/FK maintenance have no authenticated caller scope.
-- Admit their actual old/new family parents without waiting after a member row
-- is already locked. An inverted external lock order receives 55P03 and can
-- retry the transaction; it must not deadlock or lose the required dirty mark.
-- A family cascade sees its deleted parent absent and continues normally.
create or replace function messaging_private.lock_membership_parents()
returns trigger language plpgsql security definer set search_path = '' as $$
declare old_family uuid; new_family uuid;
begin
  if tg_op <> 'INSERT' then old_family := old.family_id; end if;
  if tg_op <> 'DELETE' then new_family := new.family_id; end if;
  perform f.id from public.families f
    where f.id = old_family or f.id = new_family
    order by f.id for key share of f nowait;
  if tg_op = 'DELETE' then return old; end if;
  return new;
exception when lock_not_available then
  raise exception 'Household is changing. Retry the membership change.' using errcode = '55P03';
end;
$$;
revoke all on function messaging_private.lock_membership_parents() from public, anon, authenticated, service_role;

drop trigger if exists trg_family_members_parent_lock on public.family_members;
create trigger trg_family_members_parent_lock before insert or update or delete on public.family_members
  for each row execute function messaging_private.lock_membership_parents();


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
    join public.family_members m on m.family_id = c.family_id
      and m.user_id = auth.uid() and m.is_active
    where c.id = p_id and (c.is_family_chat
      or m.id = any(c.participant_ids) or m.user_id = any(c.member_ids)
      or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0
        and c.created_by = m.user_id))
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
declare actor public.family_members;
begin
  if auth.uid() is not null then
    select m.* into actor from public.family_members m
      where m.family_id = new.family_id and m.user_id = auth.uid() and m.is_active
      order by m.id limit 1 for share of m;
    if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
    if tg_op = 'UPDATE' then
      if new.id is distinct from old.id or new.family_id is distinct from old.family_id
        or new.created_by is distinct from old.created_by or new.kind is distinct from old.kind
        or new.is_family_chat is distinct from old.is_family_chat
        or new.participant_ids is distinct from old.participant_ids
        or new.member_ids is distinct from old.member_ids then
        raise exception 'Start a new conversation to change its audience' using errcode = '42501';
      end if;
      if not messaging_private.can_access_conversation(old.id) then
        raise exception 'A conversation participant is required' using errcode = '42501';
      end if;
    elsif not new.is_family_chat then
      if not (actor.id = any(new.participant_ids) or actor.user_id = any(new.member_ids)
        or (cardinality(new.participant_ids) = 0 and cardinality(new.member_ids) = 0
          and new.created_by = actor.user_id)) then
        raise exception 'The caller must be a participant' using errcode = '42501';
      end if;
      if exists (select 1 from unnest(new.participant_ids) candidate(id) where candidate.id is null or not exists (
        select 1 from public.family_members m where m.id = candidate.id and m.family_id = new.family_id and m.is_active))
        or exists (select 1 from unnest(new.member_ids) candidate(id) where candidate.id is null or not exists (
          select 1 from public.family_members m where m.user_id = candidate.id and m.family_id = new.family_id and m.is_active)) then
        raise exception 'Choose active household participants' using errcode = '23514';
      end if;
    end if;
  end if;
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
grant update (name, avatar_emoji, description, is_archived) on public.family_conversations to authenticated;
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
      or m.id = any(participant_ids) or m.user_id = any(member_ids)
      or (cardinality(participant_ids) = 0 and cardinality(member_ids) = 0 and created_by = auth.uid()))));
create policy family_conversations_insert on public.family_conversations for insert to authenticated
  with check (public.is_family_member(family_id) and created_by = auth.uid() and not is_family_chat);
create policy family_conversations_update on public.family_conversations for update to authenticated
  using (messaging_private.can_access_conversation(id) and ((not is_family_chat and created_by = auth.uid()) or public.can_manage_family(family_id)))
  with check (messaging_private.can_access_conversation(id) and ((not is_family_chat and created_by = auth.uid()) or public.can_manage_family(family_id)));
create policy family_conversations_delete on public.family_conversations for delete to authenticated
  using (not is_family_chat and messaging_private.can_access_conversation(id) and (created_by = auth.uid() or public.can_manage_family(family_id)));

create or replace function messaging_private.ensure_family_conversation(
  p_family_id uuid, p_member_id uuid default null, p_user_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid; actor public.family_members;
begin
  perform messaging_private.lock_authenticated_families();
  perform 1 from public.families f where f.id = p_family_id for key share of f;
  if not found then raise exception 'Household unavailable' using errcode = '42501'; end if;
  if p_member_id is not null or p_user_id is not null then
    perform messaging_private.lock_actor(p_family_id, p_member_id, p_user_id);
  elsif auth.uid() is not null then
    select m.* into actor from public.family_members m
      where m.family_id = p_family_id and m.user_id = auth.uid() and m.is_active
      order by m.id limit 1 for share of m;
    if not found then raise exception 'An active household membership is required' using errcode = '42501'; end if;
  elsif coalesce(current_setting('role', true), '') <> 'service_role' and session_user <> 'service_role' then
    raise exception 'An active household membership is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.families f where f.id = p_family_id) then
    raise exception 'Household unavailable' using errcode = '42501';
  end if;
  insert into public.family_conversations(family_id, name, kind, avatar_emoji, created_by, is_family_chat, participant_ids, member_ids)
    select p_family_id, 'Family Chat', 'group', '👨‍👩‍👧‍👦', coalesce(p_user_id, auth.uid()), true,
      coalesce(array_agg(m.id order by m.id), '{}'),
      coalesce(array_agg(distinct m.user_id) filter (where m.user_id is not null), '{}')
    from public.family_members m where m.family_id = p_family_id and m.is_active
    on conflict (family_id) where is_family_chat do nothing;
  select c.id into result from public.family_conversations c
    where c.family_id = p_family_id and c.is_family_chat and not c.is_archived;
  if not found then raise exception 'The family chat is unavailable' using errcode = '42501'; end if;
  return result;
end;
$$;
revoke all on function messaging_private.ensure_family_conversation(uuid, uuid, uuid) from public, anon;
grant execute on function messaging_private.ensure_family_conversation(uuid, uuid, uuid) to authenticated, service_role;
-- Retire the previous one-argument candidate signature without cascading
-- dependencies. Unexpected dependent routines make replay fail for review.
drop function if exists public.ensure_family_conversation(uuid);
drop function if exists messaging_private.ensure_family_conversation(uuid);
create or replace function public.ensure_family_conversation(
  p_family_id uuid, p_member_id uuid default null, p_user_id uuid default null
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare result uuid;
begin
  result := messaging_private.ensure_family_conversation(p_family_id, p_member_id, p_user_id);
  -- Honor inherited SELECT restrictions; a refusal rolls back creation too.
  perform 1 from public.family_conversations c where c.id = result and c.family_id = p_family_id;
  if not found then raise exception 'The family chat is unavailable' using errcode = '42501'; end if;
  return result;
end;
$$;
revoke all on function public.ensure_family_conversation(uuid, uuid, uuid) from public, anon;
grant execute on function public.ensure_family_conversation(uuid, uuid, uuid) to authenticated, service_role;


-- Definer admission only locks the caller's active actor; the public create RPC
-- retains invoker INSERT/SELECT restrictions, including nonmanager participants.
create or replace function messaging_private.admit_conversation_actor(p_family_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to create a conversation' using errcode = '42501'; end if;
  perform messaging_private.lock_authenticated_families();
  perform 1 from public.family_members m where m.family_id = p_family_id and m.user_id = auth.uid() and m.is_active order by m.id for share of m;
  if not found then raise exception 'An active household membership is required' using errcode = '42501'; end if;
end;
$$;
revoke all on function messaging_private.admit_conversation_actor(uuid) from public, anon;
grant execute on function messaging_private.admit_conversation_actor(uuid) to authenticated;

create or replace function public.create_family_conversation(
  p_family_id uuid, p_participant_ids uuid[], p_name text default null, p_kind text default 'group', p_avatar_emoji text default '💬'
)
returns public.family_conversations language plpgsql security invoker set search_path = '' as $$
declare ids uuid[]; result public.family_conversations;
begin
  if auth.uid() is null or not public.is_family_member(p_family_id) then raise exception 'An active household membership is required' using errcode = '42501'; end if;
  perform messaging_private.admit_conversation_actor(p_family_id);
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
      and not exists (select 1 from unnest(c.member_ids) recorded(user_id) where recorded.user_id is null
        or not exists (select 1 from public.family_members selected where selected.id = any(ids)
          and selected.family_id = p_family_id and selected.user_id = recorded.user_id and selected.is_active))
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

-- Recorded private audiences are immutable; start a new conversation for a different roster.

create or replace function messaging_private.attachment_path(p_reference text)
returns text language sql immutable set search_path = '' as $$
  select case when p_reference ~ '^[0-9a-fA-F-]{36}/' then split_part(p_reference, '?', 1)
    else substring(p_reference from '/storage/v1/object/(?:public|sign|authenticated)/family-media/([^?]+)') end;
$$;
revoke all on function messaging_private.attachment_path(text) from public, anon;
grant execute on function messaging_private.attachment_path(text) to authenticated, service_role;

create or replace function messaging_private.message_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.family_conversations; actor public.family_members; path text;
begin
  if tg_op = 'UPDATE' and (new.id is distinct from old.id
    or new.family_id is distinct from old.family_id or new.conversation_id is distinct from old.conversation_id) then
    raise exception 'A message identity cannot change' using errcode = '42501';
  end if;
  if auth.uid() is not null then
    select m.* into actor from public.family_members m
      where m.family_id = new.family_id and m.user_id = auth.uid() and m.is_active
      order by m.id limit 1 for share of m;
    if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
  end if;
  -- Sending bumps this conversation in an AFTER INSERT trigger. Acquire its
  -- write lock up front so two senders cannot deadlock upgrading shared locks.
  if tg_op = 'INSERT' then
    select fc.* into c from public.family_conversations fc where fc.id = new.conversation_id for update of fc;
  else
    -- Updates already own the message row. Locking its conversation here can
    -- deadlock with a reply send that owns the conversation then reads this
    -- parent message. Authenticated callers cannot rewrite the audience.
    select fc.* into c from public.family_conversations fc where fc.id = new.conversation_id;
  end if;
  if not found or c.family_id <> new.family_id then
    raise exception 'A message must belong to its conversation household' using errcode = '23514';
  end if;
  if auth.uid() is not null and not (c.is_family_chat
    or actor.id = any(c.participant_ids) or actor.user_id = any(c.member_ids)
    or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0 and c.created_by = actor.user_id)) then
    raise exception 'A conversation participant is required' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and c.is_archived then raise exception 'Conversation archived' using errcode = '42501'; end if;
  if new.reply_to_id is not null and (tg_op = 'INSERT' or new.reply_to_id is distinct from old.reply_to_id) then
    perform 1 from public.family_messages m where m.id = new.reply_to_id
      and m.family_id = new.family_id and m.conversation_id = new.conversation_id and m.deleted_at is null for share of m;
    if not found then raise exception 'Reply to an available message in this conversation' using errcode = '23514'; end if;
  end if;
  if auth.uid() is not null and (tg_op = 'INSERT' or new.sender_name is distinct from old.sender_name or new.sender_avatar is distinct from old.sender_avatar) then
    new.sender_name := actor.display_name; new.sender_avatar := actor.avatar_url;
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
create or replace function messaging_private.delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare fam uuid; actor public.family_members;
begin
  if auth.uid() is null then return old; end if;
  if tg_table_name = 'families' then
    if coalesce(current_setting('role', true), 'none') in ('none', '')
      and exists (select 1 from pg_catalog.pg_roles r where r.rolname = session_user and (r.rolsuper or r.rolbypassrls)) then
      return old;
    end if;
    fam := old.id;
  else
    fam := old.family_id;
    if not exists (select 1 from public.families f where f.id = fam) then return old; end if;
    if tg_table_name = 'family_messages' then
      if not exists (select 1 from public.family_conversations c where c.id = old.conversation_id) then
        -- The conversation parent guard already holds its actual family's
        -- membership lock. Its cascade must also clean historical messages whose
        -- independent family_id FK was mis-stamped; direct DELETE cannot reach
        -- such rows under the matching-family SELECT/DELETE policies above.
        return old;
      end if;
    end if;
  end if;
  select m.* into actor from public.family_members m
    where m.family_id = fam and m.user_id = auth.uid() and m.is_active
      and (tg_table_name <> 'families' or m.role = 'parent')
    order by m.id limit 1 for share of m;
  if not found then raise exception 'An active household member is required' using errcode = '42501'; end if;
  return old;
end;
$$;
revoke all on function messaging_private.delete_guard() from public, anon, authenticated;
drop trigger if exists trg_family_message_delete_membership_guard on public.family_messages;
create trigger trg_family_message_delete_membership_guard before delete on public.family_messages
  for each row execute function messaging_private.delete_guard();
drop trigger if exists trg_family_conversation_delete_membership_guard on public.family_conversations;
create trigger trg_family_conversation_delete_membership_guard before delete on public.family_conversations
  for each row execute function messaging_private.delete_guard();
drop trigger if exists trg_family_delete_membership_guard on public.families;
create trigger trg_family_delete_membership_guard before delete on public.families
  for each row execute function messaging_private.delete_guard();


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
  using (public.is_family_member(family_id) and exists (select 1 from public.family_conversations c where c.id = family_messages.conversation_id and c.family_id = family_messages.family_id));
create policy family_messages_insert on public.family_messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_family_member(family_id) and exists (select 1 from public.family_conversations c where c.id = family_messages.conversation_id and c.family_id = family_messages.family_id));
create policy family_messages_update on public.family_messages for update to authenticated
  using (public.is_family_member(family_id) and exists (select 1 from public.family_conversations c where c.id = family_messages.conversation_id and c.family_id = family_messages.family_id))
  with check (public.is_family_member(family_id) and exists (select 1 from public.family_conversations c where c.id = family_messages.conversation_id and c.family_id = family_messages.family_id));
create policy family_messages_delete on public.family_messages for delete to authenticated
  using (sender_id = auth.uid() and public.is_family_member(family_id) and exists (select 1 from public.family_conversations c where c.id = family_messages.conversation_id and c.family_id = family_messages.family_id));

create or replace function public.toggle_family_message_reaction(p_message_id uuid, p_emoji text)
returns public.family_messages language plpgsql security invoker set search_path = '' as $$
declare result public.family_messages; people jsonb; fam uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to react' using errcode = '42501'; end if;
  if p_emoji is null or length(btrim(p_emoji)) not between 1 and 32 then raise exception 'Choose a reaction' using errcode = '22023'; end if;
  -- Read under invoker RLS first; admit family/actor before any message lock.
  select family_id into fam from public.family_messages where id=p_message_id and deleted_at is null;
  if not found then raise exception 'Message unavailable' using errcode = '42501'; end if;
  perform messaging_private.admit_conversation_actor(fam);
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
-- Voice notes upload audio. Where the bucket has an allow-list (0418 sets one),
-- add the recorder's types to it. Storage checks a list only when it has
-- entries, so a NULL or empty list already allows every type, and appending to
-- it would narrow uploads to audio alone; such a list is left as it is.
-- The bucket's public flag is not this migration's to change: making
-- family-media private belongs to 0459, which the owner has deferred in
-- production (SEC-001; kept public on 2026-09-30), so 0475 leaves it as found.
update storage.buckets set allowed_mime_types = (select array_agg(distinct t)
  from unnest(allowed_mime_types || array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav']) t)
  where id = 'family-media' and cardinality(allowed_mime_types) > 0;

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

-- The lock runs as a definer: SELECT FOR UPDATE under an invoker would apply
-- the conversation UPDATE policy and prevent a non-manager participant from
-- sending. Authorization is checked against the locked actor and audience.
create or replace function messaging_private.authorize_send(
  p_family_id uuid, p_conversation_id uuid, p_member_id uuid, p_user_id uuid
)
returns text language plpgsql security definer set search_path = '' as $$
declare actor_name text; c public.family_conversations;
begin
  actor_name := messaging_private.lock_actor(p_family_id, p_member_id, p_user_id);
  select fc.* into c from public.family_conversations fc
    where fc.id = p_conversation_id and fc.family_id = p_family_id for update of fc;
  if not found or c.is_archived then raise exception 'Conversation unavailable' using errcode = '42501'; end if;
  if not c.is_family_chat and not coalesce(p_member_id = any(c.participant_ids) or p_user_id = any(c.member_ids)
    or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0 and c.created_by = p_user_id), false) then
    raise exception 'A conversation participant is required' using errcode = '42501';
  end if;
  return actor_name;
end;
$$;
revoke all on function messaging_private.authorize_send(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function messaging_private.authorize_send(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- Atomic send: actual reads and INSERT remain invoker operations so inherited
-- restrictive table policies still apply. The private helper locks and
-- validates the explicit actor even when a service client bypasses RLS.
create or replace function public.send_family_message(
  p_family_id uuid, p_conversation_id uuid, p_member_id uuid, p_user_id uuid,
  p_content text, p_kind text default 'text', p_reply_to_id uuid default null, p_idempotency_key text default null
)
returns public.family_messages language plpgsql security invoker set search_path = '' as $$
declare actor_name text; c public.family_conversations; result public.family_messages;
begin
  if length(btrim(coalesce(p_content, ''))) not between 1 and 4000 or p_kind is null
    or p_kind not in ('text', 'announcement') then raise exception 'Choose valid message text' using errcode = '22023'; end if;
  actor_name := messaging_private.authorize_send(p_family_id, p_conversation_id, p_member_id, p_user_id);
  select fc.* into c from public.family_conversations fc
    where fc.id = p_conversation_id and fc.family_id = p_family_id;
  if not found or c.is_archived then raise exception 'Conversation unavailable' using errcode = '42501'; end if;
  if not c.is_family_chat and not coalesce(p_member_id = any(c.participant_ids) or p_user_id = any(c.member_ids)
    or (cardinality(c.participant_ids) = 0 and cardinality(c.member_ids) = 0 and c.created_by = p_user_id), false) then
    raise exception 'A conversation participant is required' using errcode = '42501';
  end if;
  if p_member_id is null and p_user_id is null and not c.is_family_chat then
    raise exception 'System sends require the family chat' using errcode = '42501';
  end if;
  if p_reply_to_id is not null then
    perform 1 from public.family_messages m where m.id = p_reply_to_id
      and m.family_id = p_family_id and m.conversation_id = p_conversation_id and m.deleted_at is null;
    if not found then raise exception 'Reply to an available message in this conversation' using errcode = '23514'; end if;
  end if;
  insert into public.family_messages(family_id, conversation_id, sender_id, sender_name, content, kind, reply_to_id, idempotency_key)
    values(p_family_id, p_conversation_id, p_user_id, actor_name, btrim(p_content), p_kind, p_reply_to_id, p_idempotency_key)
    returning * into result;
  return result;
end;
$$;
revoke all on function public.send_family_message(uuid, uuid, uuid, uuid, text, text, uuid, text) from public, anon;
grant execute on function public.send_family_message(uuid, uuid, uuid, uuid, text, text, uuid, text) to authenticated, service_role;

-- A retry is also a private-history read. Hold the same explicit actor and
-- conversation locks through the SELECT, including service clients that bypass
-- RLS. An empty set is a genuine missing match, not an all-null composite row.
-- This exact ten-minute natural match is not a durable idempotency key.
create or replace function public.find_family_message(
  p_family_id uuid, p_conversation_id uuid, p_member_id uuid, p_user_id uuid,
  p_content text, p_kind text, p_reply_to_id uuid, p_since timestamptz, p_idempotency_key text default null
)
returns setof public.family_messages language plpgsql security invoker set search_path = '' as $$
begin
  if p_since is null then raise exception 'Choose a retry window' using errcode = '22023'; end if;
  perform messaging_private.authorize_send(p_family_id, p_conversation_id, p_member_id, p_user_id);
  -- Invoker visibility retains inherited restrictive conversation/message
  -- policies. The private helper only establishes the actor and locked audience.
  perform 1 from public.family_conversations c
    where c.id = p_conversation_id and c.family_id = p_family_id;
  if not found then raise exception 'Conversation unavailable' using errcode = '42501'; end if;
  return query select m.* from public.family_messages m
    where m.family_id = p_family_id and m.conversation_id = p_conversation_id
      and m.sender_id is not distinct from p_user_id
      and ((p_idempotency_key is not null and m.idempotency_key = p_idempotency_key)
        or (p_idempotency_key is null and m.reply_to_id is not distinct from p_reply_to_id
          and m.content = p_content and m.kind = p_kind
          and m.created_at >= p_since and m.deleted_at is null))
    order by m.created_at desc, m.id desc limit 1;
end;
$$;
revoke all on function public.find_family_message(uuid, uuid, uuid, uuid, text, text, uuid, timestamptz, text) from public, anon;
grant execute on function public.find_family_message(uuid, uuid, uuid, uuid, text, text, uuid, timestamptz, text) to authenticated, service_role;
