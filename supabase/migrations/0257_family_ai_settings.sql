-- ============================================================================
-- 0257_family_ai_settings.sql — the household's own answer to "what may Bubaly
-- do without asking?" (spec §11, §12), stored where every layer can read it.
-- ----------------------------------------------------------------------------
-- Until now the answer lived only in `trust_policies` rows with
-- `subject_kind = 'ai'`: expressive, but a policy list is not a settings page,
-- and there was nowhere to record the two things §12 asks for by name — a
-- per-tool risk override, and how Bubaly may reach a child.
--
-- One row per family, because that is what it is: a preference, not an event
-- log. `category_behavior` and `risk_overrides` are jsonb because both are
-- open sets that grow with the tool registry, and a column per category would
-- turn every new tool into a migration.
--
--   behavior            'recommend' | 'prepare' | 'execute' — §11's three
--                       autonomy levels, as the whole-family default. The
--                       default is 'execute' because that is what families
--                       already experience: 'execute' adds nothing to the gate
--                       (the role matrix and the high-risk tier still decide),
--                       so this migration changes no household's behaviour on
--                       the day it applies. Dialling DOWN to 'prepare' or
--                       'recommend' is the deliberate act, made on the
--                       settings page.
--   category_behavior   {"meals": "execute", "finances": "recommend"} — per
--                       trust domain, overriding `behavior`.
--   risk_overrides      {"calendar.createEvent": "high"} — per tool. The code
--                       (lib/ai/settings.ts) keeps a FLOOR: finances and
--                       documents tools can be raised but never lowered, so a
--                       mis-set override cannot make money moves cheap.
--   child_channels      {"push": true, "email": false} — how Bubaly may reach
--                       a child directly.
--   memory_enabled      §2's opt-out: when false, nothing is remembered.
--
-- RLS mirrors every other family-scoped preference: members read, managers
-- write. The trigger seeds a row for a new family and the backfill gives every
-- existing family the same defaults, so no code path has to cope with "no row"
-- meaning something different from "defaults".
--
-- ADDITIVE + IDEMPOTENT. Safe to re-run.
-- ============================================================================

create table if not exists public.family_ai_settings (
  family_id         uuid primary key references public.families(id) on delete cascade,
  enabled           boolean not null default true,
  behavior          text not null default 'execute' check (behavior in ('recommend', 'prepare', 'execute')),
  category_behavior jsonb not null default '{}'::jsonb,
  risk_overrides    jsonb not null default '{}'::jsonb,
  child_channels    jsonb not null default '{}'::jsonb,
  memory_enabled    boolean not null default true,
  quiet_hours_start smallint check (quiet_hours_start between 0 and 23),
  quiet_hours_end   smallint check (quiet_hours_end between 0 and 23),
  updated_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.family_ai_settings enable row level security;

drop policy if exists family_ai_settings_select on public.family_ai_settings;
drop policy if exists family_ai_settings_insert on public.family_ai_settings;
drop policy if exists family_ai_settings_update on public.family_ai_settings;
drop policy if exists family_ai_settings_delete on public.family_ai_settings;
create policy family_ai_settings_select on public.family_ai_settings
  for select to authenticated using (public.is_family_member(family_id));
create policy family_ai_settings_insert on public.family_ai_settings
  for insert to authenticated with check (public.can_manage_family(family_id));
create policy family_ai_settings_update on public.family_ai_settings
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));
create policy family_ai_settings_delete on public.family_ai_settings
  for delete to authenticated using (public.can_manage_family(family_id));

-- ─── Seed on family creation ────────────────────────────────────────────────
-- The function is replaced whole (0003 is the only other definition); the
-- added statement is last so a settings failure can never cost a family its
-- parent membership or its trial.
create or replace function public.handle_new_family()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into public.family_members (family_id, user_id, role, display_name)
    values (new.id, new.created_by, 'parent',
            coalesce((select full_name from public.profiles where id = new.created_by), 'Parent'))
    on conflict (family_id, user_id) do nothing;
  end if;
  insert into public.subscriptions (family_id, plan, status, current_period_end)
  values (new.id, 'free', 'trialing', now() + interval '14 days');
  insert into public.family_ai_settings (family_id)
  values (new.id)
  on conflict (family_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_family_created on public.families;
create trigger on_family_created
  after insert on public.families
  for each row execute function public.handle_new_family();

-- ─── Backfill: every family that already exists gets the same defaults ───────
insert into public.family_ai_settings (family_id)
select f.id from public.families f
on conflict (family_id) do nothing;

-- Production verification:
--   select count(*) from public.families f
--    left join public.family_ai_settings s on s.family_id = f.id where s.family_id is null; -- 0
--   select polname, cmd from pg_policies where tablename = 'family_ai_settings';
