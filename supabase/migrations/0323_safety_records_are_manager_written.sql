-- Bubaly :: 0323 - the three safety records a child could still rewrite
--
-- 0318 made the AI Call Guardian's configuration manager-only and said why: a
-- server action is not a boundary against a JWT holder. It covered
-- `guardian_contacts` and `guardian_member_profiles`. It did not cover the table
-- that FEEDS them, and it is not the only safety surface with this shape.
--
-- ── 1 & 2. family_emergency_contacts / family_emergency_plans ───────────────
--
-- 0022_family_os.sql created both in a DO loop with
-- `FOR ALL TO authenticated USING (is_family_member(family_id))`.
--
-- The application disagrees with that in writing. lib/family/actions.ts carries
--
--   // Sensitive surfaces only managers (parent/adult) may modify.
--   const MANAGER_ONLY = new Set([
--     'family_automation_rules',
--     'family_emergency_contacts',
--     'family_emergency_plans',
--     'family_digital_twin_profiles',
--   ]);
--
-- and all three of createFamilyRecord / updateFamilyRecord / deleteFamilyRecord
-- refuse a non-manager with "Only parents and adults can change this."
-- app/(app)/dashboard/family-emergency/page.tsx agrees a second time, rendering
-- the QuickAdd form and the DeleteButton only `if (manager)`.
--
-- Two independent statements of the rule, and neither is in the database. These
-- were previously recorded as having "no app write path found"; the write path
-- is lib/family/actions.ts, reached generically by table name, which is why a
-- search for `.from('family_emergency_contacts')` did not find it.
--
-- What the rows are: `can_pickup` on a contact is the list of adults a school or
-- nursery may release a child to, and `family_emergency_plans` is the meeting
-- point and instructions for a fire or an evacuation. Measured on a replayed
-- database as a child of the family: `delete from family_emergency_contacts`
-- removed 1 row, and `update family_emergency_plans set instructions = …`
-- rewrote 1. A pickup-approved grandparent deleted, or a safe meeting spot moved
-- somewhere nobody else knows, is not something anyone would notice until the
-- day it mattered.
--
-- ── 3. guardian_suggestions — 0318's boundary, walked around ────────────────
--
-- 01370_ai_call_guardian.sql gave it the same permissive `FOR ALL`. Its writers
-- are all privileged: the learning cron and the SMS intake use
-- `createServiceClient()`, and the review decision goes through
-- `guardian_review_suggestion` (0198), a SECURITY DEFINER function that returns
-- 'forbidden' unless `can_manage_family`. There is NO legitimate write to this
-- table from an authenticated browser client, which is why closing it costs
-- nothing.
--
-- Leaving it open cost something, though, and not only the obvious "a child
-- dismisses every scam flag before a parent reads it". The table holds
-- `proposed_contact_id` and `proposed_trust_level`, and the definer function
-- applies them ON APPROVAL:
--
--   update public.guardian_contacts
--      set trust_level = v_suggestion.proposed_trust_level, trust_override = true
--    where id = v_suggestion.proposed_contact_id …
--
-- So a child who cannot write `guardian_contacts` can write the row that tells a
-- privileged function what to write there. Measured, in one transaction on the
-- replayed database, with 0318 applied and working:
--
--   as the child:  update guardian_contacts set trust_level='immediate_family'
--                    -> UPDATE 0        (0318 holds)
--   as the child:  update guardian_suggestions
--                    set proposed_trust_level = 'immediate_family',
--                        title = 'Trust this caller'
--                    -> UPDATE 1
--   as the parent: select guardian_review_suggestion(<id>, 'approved')
--                    -> {"ok": true, "status": "approved"}
--   result:        the suspected_spam caller's trust_level is 'immediate_family'
--
-- The parent did exactly what the product asked of them. A confused deputy is
-- still an open door, and it is the door 0318 thought it had shut.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads, on all three. The family-emergency page shows contacts and plans to
-- every member on purpose — a crisis surface that hides the meeting point from
-- the person who needs it is worse than useless — and /guardian renders pending
-- suggestions from the same RLS-bound read. 0318 made the same call for the same
-- reason. Only writes move.
--
-- RESTRICTIVE, as 0310 and 0318: restrictive policies AND with the union of the
-- permissive ones, so no later `FOR ALL` written out of habit can grant past
-- them — and that habit is exactly how all three of these tables got here. The
-- grant layer is closed alongside for the reason 0290 gives: these guards are
-- `TO authenticated` and are simply absent for an anonymous request, so the
-- default `arwdDxt` Supabase hands `anon` would be all that was left. SELECT is
-- left alone, as 0290 left it.
--
-- Idempotent.

do $$
declare
  t text;
begin
  foreach t in array array[
    'family_emergency_contacts', 'family_emergency_plans', 'guardian_suggestions'
  ] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_insert_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated '
      || 'using (public.can_manage_family(family_id)) '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_update_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated '
      || 'using (public.can_manage_family(family_id))', t || '_manager_delete_guard', t);
  end loop;
end
$$;

revoke insert, update, delete, truncate on public.family_emergency_contacts from anon;
revoke insert, update, delete, truncate on public.family_emergency_plans    from anon;
revoke insert, update, delete, truncate on public.guardian_suggestions      from anon;

do $$
declare
  open_tables text[];
  missing     text[];
  tbls constant text[] := array[
    'family_emergency_contacts', 'family_emergency_plans', 'guardian_suggestions'
  ];
begin
  select array_agg(t order by t) into open_tables
  from unnest(tbls) as t
  where has_table_privilege('anon', 'public.' || t, 'INSERT');
  if open_tables is not null then
    raise exception '0323: anon still holds INSERT on safety table(s): %', open_tables;
  end if;

  select array_agg(t order by t) into missing
  from unnest(tbls) as t
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = t
      and policyname = t || '_manager_update_guard' and permissive = 'RESTRICTIVE'
  );
  if missing is not null then
    raise exception '0323: restrictive manager guard missing on: %', missing;
  end if;

  raise notice '0323 OK: emergency contacts, emergency plans and Guardian suggestions are manager-written.';
end
$$;
