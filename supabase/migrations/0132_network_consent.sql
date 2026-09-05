-- Bubaly :: 0132 Family Intelligence Network — consent (foundation only)
-- ----------------------------------------------------------------------------
-- The opt-in privacy foundation for anonymized, aggregate cross-family insights
-- ("families with kids this age often start passport renewals ~6 months ahead").
-- This migration ships ONLY the consent record — default OFF, explicit, granular,
-- and revocable. NO cross-family data is read or aggregated by anything yet; that
-- pipeline is intentionally deferred until the sharing model is signed off. A
-- family sees nothing and contributes nothing unless it turns this on.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.network_consent (
  family_id   uuid primary key references public.families(id) on delete cascade,
  enabled     boolean not null default false,     -- master opt-in (default OFF)
  scopes      jsonb not null default '{}'::jsonb, -- granular per-category opt-ins
  consented_by uuid references auth.users(id) on delete set null,
  consented_at timestamptz,                        -- when it was turned on
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at trigger
drop trigger if exists set_network_consent_updated on public.network_consent;
create trigger set_network_consent_updated before update on public.network_consent
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['network_consent'] loop
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
