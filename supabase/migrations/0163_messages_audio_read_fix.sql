-- FamilyOS :: 0163 — Messages: allow audio kind + non-destructive read receipts
--
-- Two live Messages bugs:
--   1. Voice notes NEVER saved: the module inserts family_messages.kind='audio'
--      (and renders kind==='audio'), but the 0014 CHECK only allows
--      ('text','image','file','voice','poll','announcement') — every voice
--      message insert violated the constraint and failed. Widen it to include
--      'audio' (keeping every existing value, so no data rewrite).
--   2. Read receipts wiped each other: mark-as-read did
--      update({ read_by: [me] }) — REPLACING the array and erasing every other
--      reader (the family-member RLS policy allows the update, so it succeeded).
--      Add a proper append RPC the client calls instead.
--
-- Additive + idempotent. RLS unchanged; the RPC is SECURITY INVOKER, so the
-- 0014 family-member policy still governs which rows it may touch.

-- 1. Widen family_messages.kind to include 'audio'.
do $$
declare
  c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'family_messages'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';
  if c_name is not null then
    execute format('alter table public.family_messages drop constraint %I', c_name);
  end if;
end $$;

alter table public.family_messages
  add constraint family_messages_kind_check
  check (kind in ('text','image','file','voice','audio','poll','announcement'));

-- 2. Append-only mark-as-read: adds the caller to read_by on every unread,
--    non-deleted message in the conversation WITHOUT touching other readers.
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.family_messages
     set read_by = array_append(read_by, auth.uid())
   where conversation_id = p_conversation_id
     and deleted_at is null
     and auth.uid() is not null
     and not (read_by @> array[auth.uid()]);
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;
