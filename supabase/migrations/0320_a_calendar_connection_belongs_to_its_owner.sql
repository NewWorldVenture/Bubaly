-- Bubaly :: 0320 - a calendar connection belongs to the member who made it
--
-- Every sync_* table shipped with one policy, "family member access" FOR ALL
-- using is_family_member(family_id). For two of them that is wrong:
--
--   sync_accounts    one row per member per connected calendar (Google,
--                    Microsoft, ...). Any member — a child included — could
--                    UPDATE or DELETE a parent's connection directly against
--                    the API: disconnect it, or rewrite its sync direction and
--                    metadata. The app never does this: connect, disconnect and
--                    the sync engine write through the service role, and the
--                    one session-side writer (onboarding) filters to the
--                    caller's own user_id.
--   sync_audit_logs  the record of who connected, disconnected and synced
--                    what. Any member could insert a forged entry or delete a
--                    real one. Every writer runs as the service role.
--
-- So: sync_accounts stays readable to the family (the provider pages show who
-- is connected) and writable only by the member it belongs to; the audit log is
-- read-only to members. sync_tokens was already service-only and is untouched.
-- The other sync_* tables hold family-shared calendar data and are recorded as
-- a follow-up in finalaudit.md rather than changed here.
--
-- Pinned by docs/audit/calendar-connection-owner-check.sql.

do $$
begin
  if to_regclass('public.sync_accounts') is not null then
    execute 'drop policy if exists "family member access" on public.sync_accounts';
    execute 'drop policy if exists sync_accounts_select on public.sync_accounts';
    execute 'drop policy if exists sync_accounts_insert on public.sync_accounts';
    execute 'drop policy if exists sync_accounts_update on public.sync_accounts';
    execute 'drop policy if exists sync_accounts_delete on public.sync_accounts';
    execute 'create policy sync_accounts_select on public.sync_accounts for select to authenticated
               using (public.is_family_member(family_id))';
    execute 'create policy sync_accounts_insert on public.sync_accounts for insert to authenticated
               with check (public.is_family_member(family_id) and user_id = auth.uid())';
    execute 'create policy sync_accounts_update on public.sync_accounts for update to authenticated
               using (public.is_family_member(family_id) and user_id = auth.uid())
               with check (public.is_family_member(family_id) and user_id = auth.uid())';
    execute 'create policy sync_accounts_delete on public.sync_accounts for delete to authenticated
               using (public.is_family_member(family_id) and user_id = auth.uid())';
  end if;

  if to_regclass('public.sync_audit_logs') is not null then
    execute 'drop policy if exists "family member access" on public.sync_audit_logs';
    execute 'drop policy if exists sync_audit_logs_select on public.sync_audit_logs';
    execute 'create policy sync_audit_logs_select on public.sync_audit_logs for select to authenticated
               using (public.is_family_member(family_id))';
  end if;
end
$$;
