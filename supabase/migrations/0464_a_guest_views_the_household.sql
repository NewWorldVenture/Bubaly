-- Bubaly :: 0464 - a guest views the household; it does not rewrite it
--                   (ROLE-M03)
-- ----------------------------------------------------------------------------
-- `guest` is the role an extended-family invite uses: a grandparent kept in
-- the loop. Every model the product carries says a guest looks and does not
-- write:
--
--   lib/constants/roles.ts     "Guest: View limited shared events only."
--                              (what a parent reads when choosing the role)
--   public.permissions         guest: -R-- on all eight household resources
--                              (what /family/permissions shows the parent)
--   lib/trust/engine.ts        guest: capabilities ['view']
--
-- The database never said so. Measured on a database replayed through 0463,
-- as an active `guest` of the family, one row each, rolled back:
--
--   calendar_events   C R U D      grocery_items  C R U D
--   chores            C R U D      meals          C R U D
--   documents         C R U D      notes          C R U D
--   reminders         C R U D      chore_assignments  C R - -
--
-- so an invited grandparent could delete the family's calendar, its chores and
-- reminders, and the non-sensitive half of its document vault, while the page
-- the parent consults said "Read" and nothing else.
--
-- The fix is the rule all three models share, on the eight resources the
-- permission matrix names: a BEFORE INSERT, UPDATE and DELETE trigger that
-- refuses, with 42501, a caller whose role in the row's family is `guest`
-- (both the old and the new family on an UPDATE). Reads are untouched
-- (lib/trust/sharing-presets.ts: a guest still sees the ordinary shared pages
-- of their family).
--
-- A trigger rather than a RESTRICTIVE policy, for two reasons. A restrictive
-- UPDATE or DELETE policy FILTERS: the guest's write matches no row and
-- PostgREST answers `error: null`, so every screen would report a change that
-- never happened (the class tests/a-filtered-delete-is-not-a-deletion.test.ts
-- exists for). A raise is an answer the screen can show ("You don't have
-- permission …", describeDbError's 42501). And the policies on these tables are
-- what several attribution probes inventory exactly; a guard trigger keyed on
-- the guest role cannot refuse anyone they measure. The same shape as the
-- repository's other guard triggers (0223, 0305, 0326, 0331).
--
-- `family_role` (0003) is the caller's role in that family, NULL for a
-- non-member, whom the permissive policies already refuse. The service role and
-- a migration or seed (no auth.uid()) are exempt, as everywhere in this series.
--
-- Deliberately NOT here (ROLE-SCOPE-001, recorded by B15 as the owner's call): the same
-- page shows children, teens and caregivers as read-only on most of these
-- resources and adults as unable to delete, and the database lets all of them
-- write (the AUTHZ-011 "consistent-open by design" class — a child adding milk
-- to the list is the feature). Caregivers are also described two ways: the
-- matrix says read-only, the trust engine says view, create and edit. Only
-- the guest is described one way everywhere, so only the guest is enforced.
--
-- Probe: docs/audit/a-guest-views-the-household-check.sql.

create or replace function public.household_write_is_not_a_guests()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end; -- service role / server-side jobs
  end if;
  if (tg_op <> 'INSERT' and public.family_role(old.family_id) = 'guest')
     or (tg_op <> 'DELETE' and public.family_role(new.family_id) = 'guest') then
    raise exception 'A guest can see the household but not change it'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

comment on function public.household_write_is_not_a_guests() is
  'Refuses (42501) an INSERT, UPDATE or DELETE by a caller whose role in the row''s family is guest, on the eight household resources /family/permissions shows as read-only for guests (0464, ROLE-M03). The service role is exempt.';

do $$
declare
  t text;
begin
  foreach t in array array['calendar_events', 'chore_assignments', 'chores', 'documents',
                           'grocery_items', 'meals', 'notes', 'reminders'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0464: public.%.family_id does not exist', t;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_not_a_guests', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function public.household_write_is_not_a_guests()',
                   'trg_' || t || '_not_a_guests', t);
  end loop;
end
$$;
