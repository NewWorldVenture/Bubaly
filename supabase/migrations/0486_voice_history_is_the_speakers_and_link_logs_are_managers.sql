-- ── Voice history is the speaker's; linked-assistant logs are the managers' ──
--
-- #771 comment 5973585839, owner approval #927 comment 5975179712 (an audit
-- draft with synthetic tests; production access rules unchanged until a
-- separate approval); slot 0486 allocated in #927 comment 5975262129.
--
-- READ visibility only. The `voice_commands` INSERT/UPDATE/DELETE policy
-- definitions are deliberately left as they are (`is_family_member`); their
-- effective behaviour is not established by this migration's probe, and
-- whether they need narrowing is recorded for separate consideration.
--
-- `voice_commands.transcript` is a member's spoken command, verbatim
-- (components/modules/voice-module.tsx → lib/voice/history.ts). Its SELECT
-- policy was `is_family_member(family_id)`, so every member read every other
-- member's commands — the Voice module listed the family's last 20 to anyone.
-- From here a command is read by the person who spoke it or by a household
-- manager (`can_manage_family`). "The person who spoke it" is the member row
-- the command names (`is_self_member(member_id)`) or, for a row with no
-- member, the account that filed it (`created_by = auth.uid()`).
--
-- `assistant_link_events.utterance` is what someone said to a linked home
-- assistant (lib/assistant/service.ts writes it with the service role). No app
-- surface reads it back; it is a link audit log, so only a manager reads it.
--
-- The policies are replaced by name, so this is safe to re-apply. The probe is
-- docs/audit/voice-history-and-link-log-privacy-check.sql.

drop policy if exists voice_commands_select on public.voice_commands;
create policy voice_commands_select on public.voice_commands
  for select to authenticated
  using (
    public.is_family_member(family_id)
    and (
      public.can_manage_family(family_id)
      or (member_id is not null and public.is_self_member(member_id))
      or (member_id is null and created_by = auth.uid())
    )
  );

drop policy if exists assistant_link_events_select on public.assistant_link_events;
create policy assistant_link_events_select on public.assistant_link_events
  for select to authenticated
  using (public.can_manage_family(family_id));
