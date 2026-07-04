-- FamilyOS :: 0123 Family facts ("Build a persistent family knowledge graph")
-- ----------------------------------------------------------------------------
-- The persistent store behind Family Memory: durable facts the family looks up
-- again and again — sizes, allergies, preferences, key contacts, account
-- numbers, "important to know" notes. Each fact optionally hangs off a member
-- (the knowledge-graph edge) or is family-level. Powers /dashboard/knowledge.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_facts (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who it's about (null = whole family)
  category    text not null default 'other'
                check (category in ('about','preference','medical','contact','sizes','important','account','date','other')),
  label       text not null,               -- e.g. "Shoe size", "Allergy", "Pediatrician"
  value       text not null,               -- e.g. "US 2", "Peanuts", "Dr. Lee 555-0100"
  notes       text,
  is_pinned   boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_family_facts_family on public.family_facts(family_id, is_pinned desc, updated_at desc);
create index if not exists idx_family_facts_member on public.family_facts(family_id, member_id);
create index if not exists idx_family_facts_category on public.family_facts(family_id, category);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_family_facts_updated on public.family_facts;
create trigger set_family_facts_updated before update on public.family_facts
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_facts'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;
