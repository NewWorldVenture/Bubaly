-- FamilyOS :: 0153 Marketplace listing Q&A
-- ----------------------------------------------------------------------------
-- "Ask a question" on any listing — public within the family. The asker posts a
-- question; the listing owner answers. Shown inline on the listing and gathered
-- into the seller's Questions inbox. Family-scoped RLS. Additive + idempotent.

create table if not exists public.marketplace_questions (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  asker_member  uuid references public.family_members(id) on delete set null,
  question      text not null,
  answer        text,
  answered_at   timestamptz,
  answered_by   uuid references public.family_members(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_marketplace_questions_listing on public.marketplace_questions(family_id, listing_id, created_at desc);
create index if not exists idx_marketplace_questions_family on public.marketplace_questions(family_id, created_at desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_marketplace_questions_updated on public.marketplace_questions;
create trigger set_marketplace_questions_updated before update on public.marketplace_questions
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.marketplace_questions enable row level security';
  execute 'drop policy if exists marketplace_questions_select on public.marketplace_questions';
  execute 'create policy marketplace_questions_select on public.marketplace_questions for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_insert on public.marketplace_questions';
  execute 'create policy marketplace_questions_insert on public.marketplace_questions for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_update on public.marketplace_questions';
  execute 'create policy marketplace_questions_update on public.marketplace_questions for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_delete on public.marketplace_questions';
  execute 'create policy marketplace_questions_delete on public.marketplace_questions for delete using (public.is_family_member(family_id))';
end $$;
