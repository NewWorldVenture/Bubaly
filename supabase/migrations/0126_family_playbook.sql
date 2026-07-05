-- FamilyOS :: 0126 Family Playbook ("Family Intelligence Layer / Playbook")
-- ----------------------------------------------------------------------------
-- North-star pillar #3: every interaction improves understanding. Bubaly learns
-- durable preferences/traditions from real household usage (favorite meals,
-- grocery staples, family favorites, annual traditions) and proposes them as
-- SUGGESTIONS the family confirms — the confirmed ones become real
-- `family_facts` rows (the persistent Knowledge Base, migration 0123). This
-- table is the learning inbox: candidate facts with provenance + confidence +
-- an accept/dismiss lifecycle. The family stays in control (nothing is saved
-- until confirmed).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_playbook_suggestions (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who it's about (null = whole family)
  -- Mirrors the family_facts category set so an accepted suggestion maps 1:1.
  category    text not null default 'preference'
                check (category in ('about','preference','medical','contact','sizes','important','account','date','other')),
  label       text not null,               -- e.g. "Go-to dinner", "Grocery staple"
  value       text not null,               -- e.g. "Taco night", "Oat milk"
  evidence    text,                        -- why Bubaly inferred it ("Planned 5 times recently")
  confidence  int not null default 50 check (confidence between 0 and 100),
  signature   text not null,               -- stable dedupe key (source:slug:member)
  status      text not null default 'suggested' check (status in ('suggested','accepted','dismissed')),
  fact_id     uuid references public.family_facts(id) on delete set null,     -- the confirmed fact, once accepted
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, signature)
);
create index if not exists idx_playbook_family_status
  on public.family_playbook_suggestions(family_id, status, confidence desc);
create index if not exists idx_playbook_member
  on public.family_playbook_suggestions(family_id, member_id);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_family_playbook_updated on public.family_playbook_suggestions;
create trigger set_family_playbook_updated before update on public.family_playbook_suggestions
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_playbook_suggestions'] loop
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
