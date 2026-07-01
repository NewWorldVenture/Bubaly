-- ============================================================================
-- 0108_messages_enhance.sql — additive enhancements for the redesigned
-- Messages page (conversation tabs, archive, and the "About this chat" panel).
--
-- Safe & idempotent. No data loss. Touches only public.family_conversations.
--   • description   — free text shown in the "About this chat" panel.
--   • is_archived   — powers the "View archived conversations" filter.
--   • kind check    — widen to allow 'announcement' + 'channel' so the
--                     Announcements tab has a first-class conversation kind.
--   • index         — (family_id, is_archived, last_message_at desc) for the
--                     conversation-list query.
-- RLS is already enabled on this table (migration 0014) and unchanged here.
-- ============================================================================

alter table public.family_conversations
  add column if not exists description text;

alter table public.family_conversations
  add column if not exists is_archived boolean not null default false;

-- Widen the kind check constraint to include announcement/channel. The
-- constraint name from 0014 is the table-default; drop whatever exists and
-- recreate with the full allowed set.
do $$
declare
  c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'family_conversations'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';
  if c_name is not null then
    execute format('alter table public.family_conversations drop constraint %I', c_name);
  end if;
end $$;

alter table public.family_conversations
  add constraint family_conversations_kind_check
  check (kind in ('group', 'direct', 'announcement', 'channel'));

create index if not exists idx_family_conversations_list
  on public.family_conversations (family_id, is_archived, last_message_at desc);

-- Helps the unread-count / last-preview scan filter out soft-deleted rows.
create index if not exists idx_family_messages_family_active
  on public.family_messages (family_id, created_at desc)
  where deleted_at is null;
