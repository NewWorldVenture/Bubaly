-- Bubaly :: 0329 - the calendar/reminder sync engine's tables are not any
--                   member's to write
--
-- The two-way sync engine (lib/sync/engine/generic.ts, google.ts) runs with the
-- service role and acts on the connected account owner's OAuth token. It
-- decides what to do to the provider from these rows:
--
--   sync_calendar_events (provider 'internal') + sync_external_mappings
--     a deleted internal event with a mapping => adapter.deleteEvent(external_id)
--     a changed internal event with a mapping => adapter.patchEvent(external_id)
--     an internal event with no mapping       => adapter.insertEvent
--   sync_reminders + mappings                 => the same for tasks
--   sync_calendars.feed_enabled / feed_token  => the public, no-login ICS feed
--
-- Every one of these tables carried a "family member access" FOR ALL policy
-- (or member INSERT), so any family member, a child included, could insert a
-- deleted internal event plus a mapping naming an event on a PARENT'S Google
-- Calendar, and the next sync deleted it with the parent's token; or patch it
-- with their own content; or write events into it; or switch on a public feed
-- for any family calendar with a token of their choosing.
--
-- Writers, from the code: the engine and the sync API routes (service role)
-- for every table here, plus lib/services/onboarding-calendar, which writes
-- sync_external_mappings in the account owner's own session for their own
-- account. So:
--   * engine-only tables: member writes dropped, member SELECT kept;
--   * sync_external_mappings: writes only for a mapping of an account the
--     caller owns (sync_accounts.user_id = auth.uid(), same family).
-- sync_accounts (0320) and sync_tokens (service only) are already scoped.
--
-- Pinned by docs/audit/sync-engine-write-check.sql.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'sync_calendar_events', 'sync_calendars', 'sync_calendar_shares', 'sync_event_attendees',
    'sync_reminders', 'sync_reminder_lists', 'sync_notes', 'sync_note_folders',
    'sync_connections', 'sync_settings', 'sync_jobs', 'sync_job_runs',
    'sync_conflicts', 'sync_conflict_resolutions', 'sync_change_logs',
    'sync_provider_errors', 'sync_webhook_events', 'sync_external_mappings'
  ] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
  end loop;

  if to_regclass('public.sync_external_mappings') is not null then
    execute $p$
      create policy sync_external_mappings_owner_insert on public.sync_external_mappings
        for insert to authenticated
        with check (
          public.is_family_member(family_id)
          and (user_id is null or user_id = auth.uid())
          and exists (select 1 from public.sync_accounts a
                       where a.id = sync_external_mappings.account_id
                         and a.family_id = sync_external_mappings.family_id
                         and a.user_id = auth.uid())
        )
    $p$;
    execute $p$
      create policy sync_external_mappings_owner_update on public.sync_external_mappings
        for update to authenticated
        using (
          public.is_family_member(family_id)
          and exists (select 1 from public.sync_accounts a
                       where a.id = sync_external_mappings.account_id
                         and a.family_id = sync_external_mappings.family_id
                         and a.user_id = auth.uid())
        )
        with check (
          public.is_family_member(family_id)
          and (user_id is null or user_id = auth.uid())
          and exists (select 1 from public.sync_accounts a
                       where a.id = sync_external_mappings.account_id
                         and a.family_id = sync_external_mappings.family_id
                         and a.user_id = auth.uid())
        )
    $p$;
    execute $p$
      create policy sync_external_mappings_owner_delete on public.sync_external_mappings
        for delete to authenticated
        using (
          public.is_family_member(family_id)
          and exists (select 1 from public.sync_accounts a
                       where a.id = sync_external_mappings.account_id
                         and a.family_id = sync_external_mappings.family_id
                         and a.user_id = auth.uid())
        )
    $p$;
  end if;
end
$$;
