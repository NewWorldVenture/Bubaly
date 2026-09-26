-- Bubaly :: 0342 - a family conversation is not any member's to wipe
--
-- family_conversations had the same FOR ALL-to-the-family policy as its
-- messages (0341). Deleting a conversation cascades to every message in it, so
-- any member - a child - could erase the whole Family Chat, or rewrite a
-- DM's participant list and name. The application only ever INSERTs
-- conversations (messages-module, lib/services/messages), naming the caller as
-- created_by; last_message_at is kept by a SECURITY DEFINER trigger. So:
-- INSERT names the caller; UPDATE and DELETE are the creator's or a manager's.
--
-- Pinned by docs/audit/conversation-owner-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.family_conversations') is null then
    return;
  end if;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'family_conversations' loop
    execute format('drop policy %I on public.family_conversations', p.policyname);
  end loop;
  create policy family_conversations_select on public.family_conversations for select to authenticated
    using (public.is_family_member(family_id));
  create policy family_conversations_insert on public.family_conversations for insert to authenticated
    with check (public.is_family_member(family_id) and created_by = auth.uid());
  create policy family_conversations_update on public.family_conversations for update to authenticated
    using (public.is_family_member(family_id) and (created_by = auth.uid() or public.can_manage_family(family_id)))
    with check (public.is_family_member(family_id) and (created_by = auth.uid() or public.can_manage_family(family_id)));
  create policy family_conversations_delete on public.family_conversations for delete to authenticated
    using (public.is_family_member(family_id) and (created_by = auth.uid() or public.can_manage_family(family_id)));
end
$$;
