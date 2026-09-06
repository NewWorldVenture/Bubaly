-- 0272_rsvp_is_first_person.sql — an RSVP is a statement about a person, so
-- only that person (or a parent acting for them) may make it.
--
-- 0047 shipped event_rsvps with ONE policy for every verb:
--
--     create policy "Members can manage event_rsvps" on public.event_rsvps
--       for all to authenticated
--       using (public.is_family_member(family_id))
--       with check (public.is_family_member(family_id));
--
-- No member predicate on either side. So any member of the household — a teen,
-- a child, a guest — can INSERT an 'accepted' row carrying a parent's member_id,
-- or UPDATE a sibling's reply, or DELETE one. And because
-- `event_rsvps_once UNIQUE (event_id, member_id)` makes the write an upsert, a
-- second answer does not sit alongside the first; it REPLACES it, silently.
--
-- Nothing in the product does this. The event modal writes only
-- `selfMemberId`, and `rsvpToEvent` takes `member_id` from `scope.memberId` and
-- never from a caller's arguments — a discipline that exists because this code
-- once used `members[0]` as though it were a lookup, so a teen saying "I'm
-- going" answered as whoever sorted first in the roster.
--
-- That app-level care is the ONLY thing standing between a child and a reply in
-- a parent's name. This migration puts the same rule where it cannot be
-- forgotten by the next writer.
--
-- WHAT STAYS OPEN, DELIBERATELY:
--   * SELECT is unchanged. Seeing who is coming is the point of an RSVP.
--   * A MANAGER may still write anyone's row. A parent answering for a
--     six-year-old with no login is a real thing families do — and it is what
--     lets an approved RSVP replay: `performApproved` runs under the approving
--     parent's client while writing the ASKER's member_id, so without the
--     manager branch this migration would break the approval path it is meant
--     to protect.
--
-- notes and goals carry the same shape — `is_family_member` and nothing else —
-- and are NOT changed here. A shared family notepad being collaboratively
-- editable is plausibly the intent, so tightening it is a product decision
-- rather than a security fix, and is recorded in the gap ledger for someone to
-- make deliberately.

-- Is this member row me? Security definer so the policy can read the roster
-- without the caller needing to.
create or replace function public.is_self_member(p_member_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where id = p_member_id and user_id = auth.uid() and is_active
  );
$$;

alter table public.event_rsvps enable row level security;

-- The single FOR ALL policy is replaced by four. Permissive policies are OR'd,
-- so leaving the old one in place would defeat every narrower rule below.
drop policy if exists "Members can manage event_rsvps" on public.event_rsvps;
drop policy if exists event_rsvps_select on public.event_rsvps;
drop policy if exists event_rsvps_insert on public.event_rsvps;
drop policy if exists event_rsvps_update on public.event_rsvps;
drop policy if exists event_rsvps_delete on public.event_rsvps;

create policy event_rsvps_select on public.event_rsvps
  for select to authenticated
  using (public.is_family_member(family_id));

create policy event_rsvps_insert on public.event_rsvps
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and (public.is_self_member(member_id) or public.can_manage_family(family_id))
  );

create policy event_rsvps_update on public.event_rsvps
  for update to authenticated
  using (
    public.is_family_member(family_id)
    and (public.is_self_member(member_id) or public.can_manage_family(family_id))
  )
  with check (
    public.is_family_member(family_id)
    and (public.is_self_member(member_id) or public.can_manage_family(family_id))
  );

create policy event_rsvps_delete on public.event_rsvps
  for delete to authenticated
  using (
    public.is_family_member(family_id)
    and (public.is_self_member(member_id) or public.can_manage_family(family_id))
  );
