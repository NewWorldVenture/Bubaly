-- Bubaly :: 0188 - Pin SECURITY DEFINER trigger functions
--
-- Migration 0014 created these trigger functions without a fixed search_path.
-- They are invoked by PostgreSQL triggers, not by clients, so direct execution
-- is revoked while the trigger behavior remains unchanged.

begin;

create or replace function public.sync_album_photo_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (TG_OP = 'INSERT') then
    update public.family_albums
    set photo_count = photo_count + 1, updated_at = now()
    where id = NEW.album_id;
  elsif (TG_OP = 'DELETE') then
    update public.family_albums
    set photo_count = greatest(0, photo_count - 1), updated_at = now()
    where id = OLD.album_id;
  end if;
  return null;
end;
$$;

create or replace function public.update_conversation_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.family_conversations
  set last_message_at = NEW.created_at, updated_at = now()
  where id = NEW.conversation_id;
  return NEW;
end;
$$;

revoke execute on function public.sync_album_photo_count() from public, anon, authenticated;
revoke execute on function public.update_conversation_last_message() from public, anon, authenticated;

commit;
