-- FamilyOS :: 0105 — Child logins (no email required)
--
-- Lets a parent give a child (who has no email) a real account they can sign
-- into with a simple username + 4-digit PIN. The child gets a Supabase Auth user
-- created under a synthetic, never-emailed address; this table maps the public
-- login username → that auth user + family member so sign-in can resolve it.
--
-- The child's family_members row is linked to the auth user via family_members.user_id
-- (set by the create action), so once they sign in they ARE their member — chores,
-- rewards, the /kids surface, everything already works.

create table if not exists public.child_logins (
  id          uuid        primary key default gen_random_uuid(),
  family_id   uuid        not null references public.families(id) on delete cascade,
  member_id   uuid        not null references public.family_members(id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,  -- child's synthetic auth user
  username    text        not null,
  created_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (member_id),
  unique (user_id)
);

-- Case-insensitive unique username (the public login handle).
create unique index if not exists idx_child_logins_username_lower on public.child_logins (lower(username));
create index if not exists idx_child_logins_family on public.child_logins (family_id);

drop trigger if exists trg_set_updated_at on public.child_logins;
create trigger trg_set_updated_at before update on public.child_logins
  for each row execute function public.set_updated_at();

alter table public.child_logins enable row level security;

-- Family members can SEE their family's child logins (managers manage them via
-- service-role server actions that assert the manager role; anonymous username→
-- email resolution at sign-in also runs through the service role). No public read.
drop policy if exists "Members can view child_logins" on public.child_logins;
create policy "Members can view child_logins" on public.child_logins
  for select to authenticated
  using (public.is_family_member(family_id));

drop policy if exists "Managers manage child_logins" on public.child_logins;
create policy "Managers manage child_logins" on public.child_logins
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));
