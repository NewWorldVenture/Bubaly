-- Guardian's screening decisions are the parents'. (AUTHZ-005)
--
-- Guardian screens a family's calls and texts. Who rings through, who goes to
-- voicemail and who is blocked is decided by:
--
--   guardian_contacts        each caller's trust_level (blocked … immediate_family)
--   guardian_member_profiles how each member's calls are handled per trust level,
--                            and whether screening is on for them at all
--   guardian_suggestions     proposals a parent approves — guardian_review_suggestion
--                            applies whatever proposed_* the row holds at that moment
--
-- `guardian_routing_rules` was already manager-only. These three were
-- `FOR ALL is_family_member`, so the rules' protection could be walked around:
-- AUTHZ-005 recorded the gap from the policy source and asked for it to be
-- reproduced before it was repaired. Reproduced on the local stack as a child
-- (docs/audit/guardian-authority-check.sql, six findings):
--
--   BREACH: a child rewrote a pending suggestion before a parent approved it
--   BREACH: a child raised a blocked caller to immediate_family
--   BREACH: a child added a trusted contact
--   BREACH: a child deleted a blocked caller's record
--   BREACH: a child deleted a parent's manager-only routing rule by deleting
--           the contact it names (cascade)
--   BREACH: a child switched off their own call screening
--
-- The fifth is the one the policy source could not show on its own:
-- `guardian_routing_rules.condition_contact_id` is ON DELETE CASCADE, so a
-- member who could delete a contact could delete the manager-only rule attached
-- to it without ever touching the rules table.
--
-- `guardian_communications` is included for the same reason at lower stakes:
-- members could INSERT call and text records, which feed the learning run that
-- proposes trust changes. Only the provider webhooks write it, as the service
-- role.
--
-- Every product writer is parent-only (upsertContactAction,
-- updateContactTrustAction, deleteContactAction, upsertMemberProfileAction,
-- updateContextAction, assignGuardianPhoneAction, generateGuardianSuggestionsAction)
-- or the service role (the SMS/voice/WhatsApp pipeline, the learning cron), so
-- managers-only takes nothing away. SELECT is untouched: a child still sees the
-- family's contacts. RESTRICTIVE guards in 0217's shape, ANDing with the family
-- policies already there.

-- ── what main already had, and what is left ───────────────────────────────
--
-- 0318 and 0345 rebuilt the write policies on guardian_contacts,
-- guardian_member_profiles and guardian_suggestions as manager writes, which
-- closes the first six breaches above. They are not restated here.
-- `guardian_communications` was left as it was: "Service can insert
-- guardian_communications" is a PERMISSIVE INSERT to authenticated with
-- `is_family_member(family_id)` — so despite its name any member, a child
-- included, could write a call or text record into the history the learning
-- run reads. That table is what this migration closes. It has no UPDATE or
-- DELETE policy for authenticated today; the guards cover those verbs too, so
-- a later permissive policy cannot quietly reopen them.

do $$
begin
  if to_regclass('public.guardian_communications') is null then return; end if;
  drop policy if exists guardian_communications_manager_insert_guard on public.guardian_communications;
  drop policy if exists guardian_communications_manager_update_guard on public.guardian_communications;
  drop policy if exists guardian_communications_manager_delete_guard on public.guardian_communications;
  create policy guardian_communications_manager_insert_guard on public.guardian_communications
    as restrictive for insert to authenticated with check (public.can_manage_family(family_id));
  create policy guardian_communications_manager_update_guard on public.guardian_communications
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
  create policy guardian_communications_manager_delete_guard on public.guardian_communications
    as restrictive for delete to authenticated using (public.can_manage_family(family_id));
  revoke insert, update, delete on public.guardian_communications from anon;
end $$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'guardian_communications'
     and p.polname like '%\_manager\_%\_guard' and not p.polpermissive;
  if n <> 3 then
    raise exception 'guardian_communications: expected 3 restrictive manager guards, found %', n;
  end if;
end $$;
