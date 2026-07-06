-- ============================================================================
-- FamilyOS :: Consolidated pending-production migrations (0118 → 0134)
-- ============================================================================
-- Supersedes APPLY_PENDING_0118-0125.sql. Every migration below is additive +
-- idempotent (IF NOT EXISTS / drop-then-create policies / guarded blocks), so
-- re-running an already-applied one is a no-op — safe to paste the whole file.
--
-- HOW TO APPLY (pick one):
--   * Supabase CLI (recommended):  supabase db push
--   * SQL editor: paste this entire file and Run (single transaction).
--
-- Agents cannot apply to prod (no prod DB creds in the sandbox). Human-owned.
-- ============================================================================
BEGIN;

-- ==================== 0118_rls_drift_repair.sql ====================
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

-- ==================== 0119_family_credentials.sql ====================
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

-- ==================== 0120_marketplace.sql ====================
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

-- ==================== 0121_voice_commands.sql ====================
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

-- ==================== 0122_routine_templates.sql ====================
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

-- ==================== 0123_family_facts.sql ====================
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

-- ==================== 0124_journey_events.sql ====================
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

-- ==================== 0125_family_operating_index.sql ====================
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

-- ==================== 0126_family_playbook.sql ====================
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

-- ==================== 0127_agent_activity.sql ====================
-- FamilyOS :: 0127 Agent activity (North Star pillar #6 — specialized agents)
-- ----------------------------------------------------------------------------
-- The family sees one assistant; behind it a roster of domain agents (Chief of
-- Staff, Scheduler, Meal Planner, Budget Coach, …). This table is the persistent
-- record of what each agent surfaces or does — an auditable "system of
-- execution" log the /dashboard/agents surface reads (live briefings are
-- computed; this is the durable history the family can act on / dismiss).
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.agent_activity (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,   -- who it's about (null = whole family)
  agent       text not null,                     -- AgentId, e.g. 'scheduler'
  kind        text not null default 'insight'
                check (kind in ('insight','recommendation','action','handoff')),
  title       text not null,
  detail      text,
  href        text,
  severity    text not null default 'info' check (severity in ('info','attention','action')),
  status      text not null default 'active' check (status in ('active','done','dismissed')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_agent_activity_family on public.agent_activity(family_id, status, created_at desc);
create index if not exists idx_agent_activity_agent  on public.agent_activity(family_id, agent, created_at desc);

-- updated_at trigger
drop trigger if exists set_agent_activity_updated on public.agent_activity;
create trigger set_agent_activity_updated before update on public.agent_activity
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['agent_activity'] loop
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

-- ==================== 0128_family_connections.sql ====================
-- FamilyOS :: 0128 Family connections (North Star pillar #9 — Family API)
-- ----------------------------------------------------------------------------
-- The orchestration hub: a durable, family-scoped record of the external
-- services a family connects (calendars, email, banking, grocery, smart home).
-- This is the data model the OAuth/token flows populate as each provider is
-- enabled server-side; the /dashboard/connections surface reads + manages it.
-- Tokens themselves are NOT stored here (they belong in a secret store) — this
-- tracks the connection, account label, status, and last sync.
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.family_connections (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,
  provider            text not null,                 -- e.g. 'google_calendar'
  category            text not null default 'other'
                        check (category in ('calendar','email','banking','grocery','smart_home','other')),
  status              text not null default 'connected'
                        check (status in ('connected','syncing','error','disconnected')),
  account_label       text,                          -- e.g. 'mom@gmail.com'
  external_account_id text,
  last_synced_at      timestamptz,
  error_message       text,
  metadata            jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One live row per family+provider+account (re-connecting the same account is an upsert).
  unique (family_id, provider, external_account_id)
);
create index if not exists idx_family_connections_family on public.family_connections(family_id, status, category);

-- updated_at trigger
drop trigger if exists set_family_connections_updated on public.family_connections;
create trigger set_family_connections_updated before update on public.family_connections
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_connections'] loop
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

-- ==================== 0129_family_graph.sql ====================
-- FamilyOS :: 0129 Family Knowledge Graph (the reasoning substrate)
-- ----------------------------------------------------------------------------
-- The moat: instead of isolated tables, model the household as a graph of typed
-- ENTITIES (people, activities, places, orgs, items, events, pets…) linked by
-- typed EDGES (child --plays--> activity --at--> place --coached_by--> person).
-- Once relationships are first-class, the AI can *reason across* the household
-- (traverse, find dependencies, propagate impact: weather -> field -> game ->
-- travel -> dinner) rather than just retrieve rows. This is what makes autonomous
-- planning, the decision engine, and the Chief of Staff possible.
--
-- graph_entities  — typed nodes. `ref_table`/`ref_id` optionally link a node to
--                   an existing row (a family_member, calendar_event, place…) so
--                   the graph augments the app instead of duplicating it.
-- graph_edges     — directed, typed relationships between two entities, with an
--                   optional weight (edge strength) + metadata.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.graph_entities (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  kind        text not null default 'other'
                check (kind in ('person','activity','place','org','event','item','pet','topic','other')),
  name        text not null,
  ref_table   text,                          -- e.g. 'family_members', 'calendar_events' (nullable)
  ref_id      uuid,                          -- row it mirrors, if any
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_graph_entities_family on public.graph_entities(family_id, kind);
create index if not exists idx_graph_entities_ref on public.graph_entities(family_id, ref_table, ref_id);
-- One graph node per underlying row, so the twin projector can upsert idempotently
-- (a family_member/vehicle/team is mirrored exactly once). Plain (non-partial) so
-- PostgREST .upsert(onConflict) can target it; NULL ref rows (manual/seeded nodes)
-- are treated as distinct by Postgres, so they're unconstrained.
create unique index if not exists uq_graph_entities_ref
  on public.graph_entities(family_id, ref_table, ref_id);

create table if not exists public.graph_edges (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  source_id   uuid not null references public.graph_entities(id) on delete cascade,
  target_id   uuid not null references public.graph_entities(id) on delete cascade,
  relation    text not null,                 -- e.g. 'plays','at','coached_by','member_of','affects','needs','parent_of'
  weight      numeric not null default 1     check (weight >= 0 and weight <= 1),
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- one edge of a given relation between the same two nodes
  unique (family_id, source_id, target_id, relation),
  check (source_id <> target_id)
);
create index if not exists idx_graph_edges_family on public.graph_edges(family_id);
create index if not exists idx_graph_edges_source on public.graph_edges(family_id, source_id, relation);
create index if not exists idx_graph_edges_target on public.graph_edges(family_id, target_id, relation);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_graph_entities_updated on public.graph_entities;
create trigger set_graph_entities_updated before update on public.graph_entities
  for each row execute function public.set_updated_at();
drop trigger if exists set_graph_edges_updated on public.graph_edges;
create trigger set_graph_edges_updated before update on public.graph_edges
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['graph_entities','graph_edges'] loop
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

-- ==================== 0130_family_decisions.sql ====================
-- FamilyOS :: 0130 Family Decision Engine
-- ----------------------------------------------------------------------------
-- Persists family trade-off decisions so they can be revisited + learned from.
-- A decision ("Which vacation?") holds a set of options, each with the metrics
-- the pure engine scores (cost / time / travel / load / benefit) plus the
-- engine's computed score + rationale. The family picks the winner (decided_
-- option_id) — the AI recommends, the family decides.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_decisions (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  question           text not null,
  detail             text,
  status             text not null default 'open'
                       check (status in ('open','decided','archived')),
  budget_cents       bigint,              -- optional hard cap
  max_travel_minutes integer,             -- optional hard cap
  weights            jsonb not null default '{}'::jsonb,  -- per-criterion overrides
  decided_option_id  uuid,                -- set when status='decided' (FK added after options table)
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_family_decisions_family on public.family_decisions(family_id, status, updated_at desc);

create table if not exists public.decision_options (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  decision_id    uuid not null references public.family_decisions(id) on delete cascade,
  label          text not null,
  cost_cents     bigint,
  time_minutes   integer,
  travel_minutes integer,
  load_delta     integer,       -- 0..100 added family burden
  benefit        integer,       -- 0..100 upside
  score          numeric,       -- last engine score 0..100 (cached)
  rationale      text,          -- last engine rationale
  feasible       boolean not null default true,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_decision_options_decision on public.decision_options(family_id, decision_id);

-- decided_option_id references decision_options (added here to avoid a cycle at create time).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_decisions_decided_option_fk'
  ) then
    alter table public.family_decisions
      add constraint family_decisions_decided_option_fk
      foreign key (decided_option_id) references public.decision_options(id) on delete set null;
  end if;
end $$;

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_family_decisions_updated on public.family_decisions;
create trigger set_family_decisions_updated before update on public.family_decisions
  for each row execute function public.set_updated_at();
drop trigger if exists set_decision_options_updated on public.decision_options;
create trigger set_decision_options_updated before update on public.decision_options
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_decisions','decision_options'] loop
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

-- ==================== 0131_prep_plans.sql ====================
-- FamilyOS :: 0131 Autonomous prep plans
-- ----------------------------------------------------------------------------
-- "Prepare, don't notify": a coordinated preparation plan for something on the
-- horizon (a trip, a birthday, an expiring document, school start), with ordered,
-- timed steps. The server generates plans from real upcoming signals (pure engine
-- in lib/planning/prep.ts) and upserts them here; the family checks steps off.
--
-- Idempotent per source signal via unique(family_id, signal_kind, signal_id).
-- Additive + family-scoped RLS via public.is_family_member.

create table if not exists public.prep_plans (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  signal_kind  text not null
                 check (signal_kind in ('trip','birthday','doc_expiry','school_start','event')),
  signal_id    text not null,          -- the source row this plan tracks
  title        text not null,
  target_date  date not null,
  urgency      text not null default 'later'
                 check (urgency in ('now','soon','later')),
  status       text not null default 'active'
                 check (status in ('active','done','dismissed')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, signal_kind, signal_id)
);
create index if not exists idx_prep_plans_family on public.prep_plans(family_id, status, target_date);

create table if not exists public.prep_plan_steps (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  plan_id    uuid not null references public.prep_plans(id) on delete cascade,
  label      text not null,
  href       text,
  due_date   date,
  lead_days  integer not null default 0,
  is_done    boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, plan_id, label)
);
create index if not exists idx_prep_plan_steps_plan on public.prep_plan_steps(family_id, plan_id, sort_order);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_prep_plans_updated on public.prep_plans;
create trigger set_prep_plans_updated before update on public.prep_plans
  for each row execute function public.set_updated_at();
drop trigger if exists set_prep_plan_steps_updated on public.prep_plan_steps;
create trigger set_prep_plan_steps_updated before update on public.prep_plan_steps
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['prep_plans','prep_plan_steps'] loop
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

-- ==================== 0132_network_consent.sql ====================
-- FamilyOS :: 0132 Family Intelligence Network — consent (foundation only)
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

-- ==================== 0133_onboarding_events.sql ====================
-- FamilyOS :: 0133 Onboarding telemetry (pre-family funnel)
-- ----------------------------------------------------------------------------
-- journey_events is family-scoped, but onboarding happens BEFORE a family exists
-- (no family_id yet), so it can't be tracked there. This is the anonymous/pre-
-- family funnel: one row per onboarding step reached, grouped by an anonymous
-- client session_id (+ the user_id once known). It powers a super-admin funnel
-- view (reach per step, completion rate, drop-off, median time). Insert is open
-- (telemetry, pre-auth), but a row can only be READ by its own user; cross-user
-- aggregation is service-role only.
--
-- Additive + idempotent.

create table if not exists public.onboarding_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,  -- null before signup
  session_id  text not null,                                       -- anonymous run id
  step        text not null,                                       -- 'profile' | 'pin' | 'done' | …
  phase       text not null default 'step'
                check (phase in ('started','step','completed','abandoned')),
  duration_ms integer,                                             -- ms since the run started
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_onboarding_events_session on public.onboarding_events(session_id, created_at);
create index if not exists idx_onboarding_events_step on public.onboarding_events(step, phase);
create index if not exists idx_onboarding_events_created on public.onboarding_events(created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.onboarding_events enable row level security;

-- Anyone (anon or authenticated) may record their own funnel step. Rows with a
-- user_id must match the caller; anonymous (null) rows are allowed pre-signup.
drop policy if exists onboarding_events_insert on public.onboarding_events;
create policy onboarding_events_insert on public.onboarding_events
  for insert with check (user_id is null or user_id = auth.uid());

-- A user can read only their own rows. Admin analytics uses the service role.
drop policy if exists onboarding_events_select on public.onboarding_events;
create policy onboarding_events_select on public.onboarding_events
  for select using (user_id is not null and user_id = auth.uid());

-- ==================== 0134_model_dirty.sql ====================
-- FamilyOS :: 0134 Model staleness flag (event-driven twin refresh)
-- ----------------------------------------------------------------------------
-- Makes the Household Twin graph + Prep Plans refresh EVENT-DRIVEN, not just on a
-- schedule. When any cross-domain source row changes (members, pets, vehicles,
-- schools, teams, routines, places, accounts, trips, documents), a trigger stamps
-- the family's row in `family_model_dirty`. The model-refresh cron then prioritizes
-- dirty families and clears the flag after a successful refresh, so a change is
-- reflected on the next tick instead of waiting a full cycle.
--
-- Additive + idempotent. Family-scoped RLS (read-only to members; writes happen
-- via SECURITY DEFINER trigger, never directly from clients).

create table if not exists public.family_model_dirty (
  family_id   uuid primary key references public.families(id) on delete cascade,
  dirty       boolean not null default true,
  reason      text,                    -- last table that dirtied it
  marked_at   timestamptz not null default now(),
  refreshed_at timestamptz
);

alter table public.family_model_dirty enable row level security;
drop policy if exists family_model_dirty_select on public.family_model_dirty;
create policy family_model_dirty_select on public.family_model_dirty
  for select using (public.is_family_member(family_id));
-- No client insert/update/delete policies: only the trigger (definer) + service role write.

-- Trigger function: mark the changed row's family dirty. SECURITY DEFINER so it can
-- write regardless of the caller's RLS. Resolves family_id from the affected row.
create or replace function public.mark_model_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid;
begin
  v_family := coalesce((case when tg_op = 'DELETE' then old.family_id else new.family_id end), null);
  if v_family is not null then
    insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
    values (v_family, true, tg_table_name, now())
    on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();
  end if;
  return null; -- AFTER trigger, result ignored
end $$;

-- Attach the trigger to every cross-domain source table the twin projector reads.
do $$
declare
  t text;
  tables text[] := array[
    'family_members','pets','vehicles','school_classes','teams',
    'family_routines','family_places','financial_accounts','vacations','documents'
  ];
begin
  foreach t in array tables loop
    -- Skip gracefully if a table doesn't exist in this environment.
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_mark_model_dirty on public.%I', t);
      execute format(
        'create trigger trg_mark_model_dirty after insert or update or delete on public.%I '
        'for each row execute function public.mark_model_dirty()', t);
    end if;
  end loop;
end $$;

COMMIT;
