-- Bubaly :: 0211 - Restore manager-only family membership updates
--
-- Migration 0118 reasserted the old self-update exception from 0004. That
-- exception lets any authenticated member update their own membership row,
-- including role, active state, and family_id. Server-side profile and
-- child-login flows already use the service role after their application-level
-- authorization checks, so ordinary clients must not update membership rows.

alter table public.family_members enable row level security;

drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
