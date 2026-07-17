-- FamilyOS :: 0225 - pin search_path on the last two SECURITY DEFINER functions
--
-- Postgres SECURITY DEFINER functions run with the OWNER's privileges, so an
-- unpinned search_path is a hardening gap: a caller who does `set search_path`
-- before triggering the function could shadow an UNQUALIFIED table/function the
-- body references and have the definer execute it with elevated rights (this is
-- what the Supabase linter flags as `function_search_path_mutable`).
--
-- An audit of all 61 SECURITY DEFINER functions found 59 already pin
-- `set search_path`; only these two (from 0014) did not:
--   * public.sync_album_photo_count()          (trigger on family_photos)
--   * public.update_conversation_last_message() (trigger on family_messages)
-- Both are actually safe TODAY — every table reference is already schema-
-- qualified (`public.family_albums` / `public.family_conversations`) and they
-- call only built-ins (now/greatest, resolved from pg_catalog) — so this is
-- defense-in-depth + linter compliance, not a live exploit. Pinning the path
-- also protects them against a future edit that introduces an unqualified ref.
--
-- `create or replace function` keeps the same function OID, so the existing
-- triggers (trg on family_photos / family_messages) continue to use it — no
-- trigger changes needed. Idempotent.

create or replace function public.sync_album_photo_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (TG_OP = 'INSERT') then
    update public.family_albums set photo_count = photo_count + 1, updated_at = now() where id = NEW.album_id;
  elsif (TG_OP = 'DELETE') then
    update public.family_albums set photo_count = greatest(0, photo_count - 1), updated_at = now() where id = OLD.album_id;
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
