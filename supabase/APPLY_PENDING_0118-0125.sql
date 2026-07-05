-- ============================================================================
-- FamilyOS :: Consolidated pending-production migrations (0118 → 0125)
-- ============================================================================
-- WHY THIS FILE EXISTS
--   These 8 migrations are on `main` but may not yet be applied to the PRODUCTION
--   Supabase database. Until they are, the features they back render empty / 404
--   in prod even though the code is deployed. This is the SAME content as the
--   individual files in supabase/migrations/, concatenated in order so it can be
--   applied in ONE paste.
--
-- HOW TO APPLY (pick one)
--   • Supabase CLI (recommended):  supabase db push
--       — applies every pending migration; you do not need this file.
--   • Supabase SQL editor:  paste THIS ENTIRE FILE and Run.
--
-- SAFETY
--   Every block below is ADDITIVE + IDEMPOTENT (guarded with IF NOT EXISTS /
--   EXCEPTION WHEN duplicate_object / drift-safe policy re-creates), and each was
--   validated on a throwaway PostgreSQL 16 when it shipped. Re-running an
--   already-applied migration is a no-op. Wrapped in a single transaction so a
--   failure rolls back cleanly with nothing half-applied.
--
--   Agents cannot run this against prod (no prod DB credentials in the sandbox).
--   This is a HUMAN-OWNED action. See docs/PENDING_PROD_MIGRATIONS.md.
-- ============================================================================

begin;


-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0118_rls_drift_repair.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- 0118_rls_drift_repair.sql
-- Consolidated repair for the systemic production RLS drift found on 2026-06-30:
-- tables had RLS ENABLED but their family-scoped policies were missing in prod,
-- so every authenticated read silently returned 0 rows ("seeded but page is
-- empty"). Piecemeal repairs shipped as 0105 (calendar_events), 0106 (todos),
-- 0107 (meals domain), 0109 (finance domain); this migration closes the TODO by
-- auditing EVERY table and healing whatever is still broken — including tables
-- added since — in one idempotent pass.
--
-- Safety model (cannot weaken anything):
--   A. RLS is (re-)enabled on every public base table — same as 0004.
--   B. The special-case tables from 0004 (profiles, families, family_members,
--      invites, notifications, audit_logs, billing_customers, subscriptions,
--      user_preferences) get their ORIGINAL, stricter policy shapes re-asserted
--      verbatim (drop-if-exists + create — a faithful re-run of 0004).
--   C. Every OTHER table with a family_id column is healed ONLY IF it currently
--      has NO SELECT policy at all (the drift symptom). Tables that already
--      carry any select policy — including intentionally stricter custom ones —
--      are left completely untouched.
-- Re-running is a no-op wherever policies exist. Postgres-only; no data change.

-- A) Enable RLS everywhere (idempotent) ---------------------------------------
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- B) Re-assert 0004's special-case policies verbatim ---------------------------
-- profiles: self + family visibility; self-only writes.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and them.user_id = public.profiles.id
    )
  );
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid());

-- families
drop policy if exists families_select on public.families;
create policy families_select on public.families for select
  using (public.is_family_member(id));
drop policy if exists families_insert on public.families;
create policy families_insert on public.families for insert
  with check (created_by = auth.uid());
drop policy if exists families_update on public.families;
create policy families_update on public.families for update
  using (public.can_manage_family(id));
drop policy if exists families_delete on public.families;
create policy families_delete on public.families for delete
  using (public.is_family_admin(id));

-- family_members
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert
  with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id) or user_id = auth.uid());
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete
  using (public.can_manage_family(family_id));

-- invites
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (
    public.is_family_member(family_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert
  with check (public.can_manage_family(family_id));
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete
  using (public.can_manage_family(family_id));

-- notifications (recipient-scoped or family broadcast)
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  with check (public.is_family_member(family_id));
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete
  using (user_id = auth.uid() or public.can_manage_family(family_id));

-- audit_logs (members append; managers read)
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select
  using (public.can_manage_family(family_id));
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert
  with check (family_id is null or public.is_family_member(family_id));

-- billing + subscriptions (members read, admin manages)
drop policy if exists billing_select on public.billing_customers;
create policy billing_select on public.billing_customers for select
  using (public.is_family_member(family_id));
drop policy if exists billing_manage on public.billing_customers;
create policy billing_manage on public.billing_customers for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select
  using (public.is_family_member(family_id));
drop policy if exists subs_manage on public.subscriptions;
create policy subs_manage on public.subscriptions for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

-- user_preferences (own only)
drop policy if exists prefs_all on public.user_preferences;
create policy prefs_all on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- C) Heal every other family_id table that has NO select policy ----------------
-- Only tables exhibiting the drift symptom (RLS on, zero select policies) get
-- the generic family CRUD set; anything with an existing select policy is
-- skipped so custom/stricter shapes are never overwritten.
do $$
declare t text;
declare healed text[] := '{}';
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'family_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_name not in (
        'families','family_members','invites','notifications','audit_logs',
        'billing_customers','subscriptions'
      )
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.table_name
          and p.cmd in ('SELECT','ALL')
      )
  loop
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    healed := array_append(healed, t);
  end loop;
  raise notice 'RLS drift repair healed % table(s): %', coalesce(array_length(healed,1),0), healed;
end $$;

-- D) Post-repair audit (informational): any family_id table still lacking a
-- select policy after this migration indicates a NEW kind of drift — investigate.
do $$
declare remaining text[];
begin
  select array_agg(c.table_name) into remaining
  from information_schema.columns c
  join information_schema.tables tb
    on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'family_id'
    and tb.table_type = 'BASE TABLE'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = c.table_name
        and p.cmd in ('SELECT','ALL')
    );
  if remaining is not null then
    raise warning 'Tables STILL missing a select policy after repair: %', remaining;
  else
    raise notice 'RLS audit clean: every family_id table has a select policy.';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0119_family_credentials.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0119 family_credentials (Wi-Fi & Passwords vault)
-- ----------------------------------------------------------------------------
-- Backs the Family hub's "Wi-Fi & Passwords" card with a real store: shared
-- family credentials (Wi-Fi networks, streaming/website/app logins, door PINs,
-- membership numbers, cards). Family-scoped RLS via public.is_family_member;
-- soft-deletable; updated_at trigger. Additive + idempotent.
--
-- NOTE: secrets are stored as text behind RLS (family-only). The UI masks them
-- by default (reveal on demand). Client-side/at-rest encryption is a documented
-- future hardening — see docs/family-vault.md.

create table if not exists public.family_credentials (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  category    text not null default 'other'
              check (category in ('wifi','website','app','streaming','email','card','pin','membership','other')),
  label       text not null,
  username    text,
  secret      text not null default '',
  url         text,
  notes       text,
  member_id   uuid references public.family_members(id) on delete set null,
  is_favorite boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_family_credentials_family    on public.family_credentials(family_id, category);
create index if not exists idx_family_credentials_active    on public.family_credentials(family_id, created_at desc) where deleted_at is null;
create index if not exists idx_family_credentials_favorite  on public.family_credentials(family_id, is_favorite) where is_favorite and deleted_at is null;

-- updated_at trigger
drop trigger if exists set_family_credentials_updated on public.family_credentials;
create trigger set_family_credentials_updated
  before update on public.family_credentials
  for each row execute function public.set_updated_at();

-- RLS: family-scoped for all operations
alter table public.family_credentials enable row level security;
drop policy if exists family_credentials_select on public.family_credentials;
create policy family_credentials_select on public.family_credentials
  for select using (public.is_family_member(family_id));
drop policy if exists family_credentials_insert on public.family_credentials;
create policy family_credentials_insert on public.family_credentials
  for insert with check (public.is_family_member(family_id));
drop policy if exists family_credentials_update on public.family_credentials;
create policy family_credentials_update on public.family_credentials
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists family_credentials_delete on public.family_credentials;
create policy family_credentials_delete on public.family_credentials
  for delete using (public.is_family_member(family_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0120_marketplace.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0120 Marketplace ("Buy, sell, rent, borrow within the platform")
-- ----------------------------------------------------------------------------
-- A family-scoped marketplace / lending board: post items to sell, rent out,
-- lend ("borrow"), give away free, or request ("wanted"). Other members express
-- interest or claim an item; the poster accepts an offer to hand it off.
--
--   • marketplace_listings — the items on the board
--   • marketplace_offers    — interest / claim requests against a listing
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── marketplace_listings ────────────────────────────────────────────────────
create table if not exists public.marketplace_listings (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  title        text not null,
  description  text,
  kind         text not null default 'sell'
                 check (kind in ('sell','rent','borrow','free','wanted')),
  category     text not null default 'other'
                 check (category in ('toys','clothing','books','electronics','furniture',
                                     'sports','tools','baby','games','other')),
  condition    text check (condition in ('new','like_new','good','fair','worn')),
  price_cents  bigint not null default 0,           -- sale price, or rate for rent
  rent_period  text check (rent_period in ('hour','day','week','month')),
  photo_url    text,
  location     text,
  status       text not null default 'available'
                 check (status in ('available','pending','claimed','completed','withdrawn')),
  claimed_by   uuid references public.family_members(id) on delete set null,
  claimed_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_marketplace_listings_family
  on public.marketplace_listings(family_id, status, created_at desc);
create index if not exists idx_marketplace_listings_member
  on public.marketplace_listings(family_id, member_id);

-- ── marketplace_offers ──────────────────────────────────────────────────────
create table if not exists public.marketplace_offers (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null default 'interest'
                check (kind in ('interest','claim','offer')),
  amount_cents bigint,                              -- optional counter-offer for 'offer'
  message     text,
  status      text not null default 'open'
                check (status in ('open','accepted','declined','withdrawn')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_marketplace_offers_listing
  on public.marketplace_offers(listing_id, status);
create index if not exists idx_marketplace_offers_family
  on public.marketplace_offers(family_id, created_at desc);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
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

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0121_voice_commands.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0121 Voice commands ("Full conversational interface")
-- ----------------------------------------------------------------------------
-- Backs the Voice Control command center (/dashboard/voice): a family-scoped log
-- of every spoken command, how it was routed (task/note/event/shopping), what it
-- created, and its outcome. The transcript log powers the "recent commands"
-- history + one-tap re-run, and gives the conversational interface a memory.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.voice_commands (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  transcript    text not null,
  resolved_kind text check (resolved_kind in ('task','note','event','shopping')),
  action_table  text,                    -- e.g. 'todo_items', 'calendar_events'
  action_count  int not null default 0,  -- rows created by this command
  status        text not null default 'routed'
                  check (status in ('routed','failed','dismissed')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_voice_commands_family
  on public.voice_commands(family_id, created_at desc);
create index if not exists idx_voice_commands_member
  on public.voice_commands(family_id, member_id);

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['voice_commands'] loop
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

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0122_routine_templates.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0122 recurring-routine templates
-- ----------------------------------------------------------------------------
-- A "routine" is a reusable bundle of related calendar events that repeats on a
-- set of weekdays — e.g. "School Morning" = wake 7:00 → breakfast 7:30 →
-- drop-off 8:00, every Mon–Fri. The per-event calendar_events.recurrence field
-- only models a single event repeating at one frequency, so routines get their
-- own tables. Applying a routine materializes concrete calendar_events.
--
-- weekday_mask: bit i set = active on that weekday, bit 0 = Monday … bit 6 =
-- Sunday (Monday-first, matching the app's week). e.g. Mon–Fri = 0b0011111 = 31.

create table if not exists public.routine_templates (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,
  icon         text,                       -- emoji
  color        text,                       -- token key (violet/blue/…)
  weekday_mask int  not null default 31 check (weekday_mask between 0 and 127),
  is_active    boolean not null default true,
  source       text not null default 'manual' check (source in ('manual','detected')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_routine_templates_family on public.routine_templates(family_id);

create table if not exists public.routine_template_items (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references public.routine_templates(id) on delete cascade,
  family_id      uuid not null references public.families(id) on delete cascade,
  title          text not null,
  category       public.event_category not null default 'general',
  start_minutes  int  not null default 0 check (start_minutes between 0 and 1439), -- from midnight
  duration_minutes int not null default 30 check (duration_minutes between 0 and 1440),
  assignee_id    uuid references public.family_members(id) on delete set null,
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_routine_items_template on public.routine_template_items(template_id);
create index if not exists idx_routine_items_family on public.routine_template_items(family_id);

-- updated_at triggers
drop trigger if exists trg_set_updated_at on public.routine_templates;
create trigger trg_set_updated_at before update on public.routine_templates
  for each row execute function public.set_updated_at();
drop trigger if exists trg_set_updated_at on public.routine_template_items;
create trigger trg_set_updated_at before update on public.routine_template_items
  for each row execute function public.set_updated_at();

-- RLS — family-scoped CRUD, same pattern as every other household table.
do $$
declare t text;
begin
  foreach t in array array['routine_templates','routine_template_items'] loop
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

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0123_family_facts.sql
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0124_journey_events.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0124 Journey events (Experience Scorecard instrumentation)
-- ----------------------------------------------------------------------------
-- Lightweight product telemetry so the Experience Scorecard uses REAL medians
-- instead of design-time estimates. Each row is one phase of a user journey
-- (started / step / completed / abandoned), grouped by a client session_id so a
-- single run can be reconstructed and its duration + step count measured.
--
-- Family-scoped RLS (a family only sees its own events). Additive + idempotent.

create table if not exists public.journey_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  journey     text not null,                -- e.g. 'capture', 'add_memory'
  phase       text not null default 'started'
                check (phase in ('started','step','completed','abandoned')),
  step        int  not null default 0,
  session_id  text not null,               -- groups one run of a journey
  duration_ms int,                         -- set on 'completed'
  created_at  timestamptz not null default now()
);
create index if not exists idx_journey_events_family on public.journey_events(family_id, journey, created_at desc);
create index if not exists idx_journey_events_session on public.journey_events(session_id);

-- ── RLS: family-scoped ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['journey_events'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    -- events are immutable: no update/delete policies (telemetry is append-only).
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ▼ 0125_family_operating_index.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- FamilyOS :: 0125 Family Operating Index (the measurable core of the Operating Layer)
-- ----------------------------------------------------------------------------
-- The Operating Layer's north-star metric is "how well is this household
-- functioning" measured over time. This table stores one append-only SNAPSHOT
-- per family per day: a weighted composite (0-100), the per-dimension scores
-- that produced it, and the ranked practical suggestions the engine surfaced.
--
-- Persisting daily lets us (a) show a trend / "what changed since yesterday",
-- (b) feed "schedule stability" from real variance over time, and (c) power the
-- Command Center's evening "what changed" summary. The score is always RECOMPUTED
-- from live data; this table is the durable ledger of those computations, never
-- the source of truth for the underlying facts.
--
-- Family-scoped RLS. Additive + idempotent (safe to re-run).

create table if not exists public.family_operating_index (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  as_of_date    date not null default current_date,      -- the local day this snapshot represents
  composite     int  not null check (composite between 0 and 100),
  band          text not null default 'steady'
                  check (band in ('thriving','steady','stretched','overloaded')),
  -- Per-dimension scores (0-100) as {key: score}; keys are the engine's dimension ids.
  dimensions    jsonb not null default '{}'::jsonb,
  -- Ranked practical suggestions [{id,title,detail,href,dimension,impact}] captured at snapshot time.
  suggestions   jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One row per family per day; the server upserts on this to stay idempotent.
  unique (family_id, as_of_date)
);
create index if not exists idx_family_operating_index_family
  on public.family_operating_index(family_id, as_of_date desc);

-- Keep updated_at honest on re-computation within the same day.
create or replace function public.touch_family_operating_index() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_family_operating_index_touch on public.family_operating_index;
create trigger trg_family_operating_index_touch
  before update on public.family_operating_index
  for each row execute function public.touch_family_operating_index();

-- ── RLS: family-scoped ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_operating_index'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

commit;
-- ── end of consolidated bundle ──────────────────────────────────────────────
