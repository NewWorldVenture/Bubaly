-- ============================================================
-- 0014_core_platform.sql
-- FamilyOS Core Platform: Messenger · Photos · Contacts ·
--   Reminders · Recipes · Shopping Lists
-- ============================================================

-- ── Family Conversations (Messenger) ────────────────────────
create table if not exists public.family_conversations (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  name         text,
  kind         text        not null default 'group' check (kind in ('group','direct')),
  avatar_emoji text        default '💬',
  member_ids   uuid[]      not null default '{}',
  created_by   uuid        references auth.users(id) on delete set null,
  last_message_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_family_conversations_family on public.family_conversations(family_id);

alter table public.family_conversations enable row level security;
drop policy if exists "family members can manage conversations" on public.family_conversations;
create policy "family members can manage conversations"
  on public.family_conversations for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Messages ──────────────────────────────────────────
create table if not exists public.family_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        references public.family_conversations(id) on delete cascade not null,
  family_id       uuid        references public.families(id) on delete cascade not null,
  sender_id       uuid        references auth.users(id) on delete set null,
  sender_name     text,
  sender_avatar   text,
  content         text,
  kind            text        not null default 'text' check (kind in ('text','image','file','voice','poll','announcement')),
  attachment_url  text,
  attachment_name text,
  attachment_mime text,
  reply_to_id     uuid        references public.family_messages(id) on delete set null,
  reactions       jsonb       not null default '{}',
  read_by         uuid[]      not null default '{}',
  is_pinned       boolean     not null default false,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_family_messages_conversation on public.family_messages(conversation_id, created_at desc);
create index if not exists idx_family_messages_family on public.family_messages(family_id);

alter table public.family_messages enable row level security;
drop policy if exists "family members can manage messages" on public.family_messages;
create policy "family members can manage messages"
  on public.family_messages for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Albums ────────────────────────────────────────────
create table if not exists public.family_albums (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  name         text        not null,
  description  text,
  cover_url    text,
  kind         text        not null default 'general'
               check (kind in ('general','vacation','school','sports','milestones','holiday','birthday','other')),
  is_shared    boolean     not null default true,
  photo_count  int         not null default 0,
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_family_albums_family on public.family_albums(family_id);

alter table public.family_albums enable row level security;
drop policy if exists "family members can manage albums" on public.family_albums;
create policy "family members can manage albums"
  on public.family_albums for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Photos ────────────────────────────────────────────
create table if not exists public.family_photos (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  album_id     uuid        references public.family_albums(id) on delete set null,
  uploaded_by  uuid        references auth.users(id) on delete set null,
  storage_path text        not null,
  url          text,
  thumbnail_url text,
  caption      text,
  taken_at     timestamptz,
  width        int,
  height       int,
  size_bytes   bigint,
  tags         text[]      not null default '{}',
  member_tags  uuid[]      not null default '{}',
  is_favorite  boolean     not null default false,
  metadata     jsonb       not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists idx_family_photos_album on public.family_photos(album_id, created_at desc);
create index if not exists idx_family_photos_family on public.family_photos(family_id, created_at desc);

alter table public.family_photos enable row level security;
drop policy if exists "family members can manage photos" on public.family_photos;
create policy "family members can manage photos"
  on public.family_photos for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- keep album photo_count in sync
create or replace function public.sync_album_photo_count()
returns trigger language plpgsql security definer as $$
begin
  if (TG_OP = 'INSERT') then
    update public.family_albums set photo_count = photo_count + 1, updated_at = now() where id = NEW.album_id;
  elsif (TG_OP = 'DELETE') then
    update public.family_albums set photo_count = greatest(0, photo_count - 1), updated_at = now() where id = OLD.album_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_album_photo_count on public.family_photos;
create trigger trg_sync_album_photo_count
  after insert or delete on public.family_photos
  for each row execute function public.sync_album_photo_count();

-- ── Family Contacts ──────────────────────────────────────────
create table if not exists public.family_contacts (
  id               uuid        primary key default gen_random_uuid(),
  family_id        uuid        references public.families(id) on delete cascade not null,
  name             text        not null,
  relationship     text        not null default 'other',
  category         text        not null default 'other'
                   check (category in ('emergency','family','doctor','dentist','teacher','coach','babysitter','neighbor','work','friend','other')),
  phone            text,
  phone_alt        text,
  email            text,
  address          text,
  notes            text,
  photo_url        text,
  is_emergency     boolean     not null default false,
  birthday_month   int         check (birthday_month between 1 and 12),
  birthday_day     int         check (birthday_day between 1 and 31),
  tags             text[]      not null default '{}',
  linked_member_id uuid        references public.family_members(id) on delete set null,
  specialty        text,
  organization     text,
  created_by       uuid        references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_family_contacts_family on public.family_contacts(family_id);
create index if not exists idx_family_contacts_emergency on public.family_contacts(family_id, is_emergency) where is_emergency = true;

alter table public.family_contacts enable row level security;
drop policy if exists "family members can manage contacts" on public.family_contacts;
create policy "family members can manage contacts"
  on public.family_contacts for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Reminders ─────────────────────────────────────────
create table if not exists public.family_reminders (
  id              uuid        primary key default gen_random_uuid(),
  family_id       uuid        references public.families(id) on delete cascade not null,
  created_by      uuid        references auth.users(id) on delete set null,
  assigned_to_id  uuid        references auth.users(id) on delete set null,
  member_id       uuid        references public.family_members(id) on delete set null,
  title           text        not null,
  notes           text,
  kind            text        not null default 'time' check (kind in ('time','location','recurring','medication','bill','school','chore')),
  remind_at       timestamptz,
  location_name   text,
  recurrence      text        not null default 'none' check (recurrence in ('none','daily','weekdays','weekly','biweekly','monthly','yearly')),
  recurrence_time time,
  recurrence_days int[]       default '{}',
  priority        text        not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status          text        not null default 'active' check (status in ('active','snoozed','completed','dismissed')),
  completed_at    timestamptz,
  snoozed_until   timestamptz,
  ai_suggested    boolean     not null default false,
  tags            text[]      not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_family_reminders_family on public.family_reminders(family_id, status, remind_at);

alter table public.family_reminders enable row level security;
drop policy if exists "family members can manage reminders" on public.family_reminders;
create policy "family members can manage reminders"
  on public.family_reminders for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Recipes ───────────────────────────────────────────
create table if not exists public.family_recipes (
  id                  uuid        primary key default gen_random_uuid(),
  family_id           uuid        references public.families(id) on delete cascade not null,
  name                text        not null,
  description         text,
  category            text        not null default 'dinner'
                      check (category in ('breakfast','lunch','dinner','snack','dessert','drink','side','appetizer','other')),
  cuisine             text,
  servings            int         not null default 4,
  prep_time_mins      int,
  cook_time_mins      int,
  difficulty          text        not null default 'medium' check (difficulty in ('easy','medium','hard')),
  ingredients         jsonb       not null default '[]',
  instructions        jsonb       not null default '[]',
  notes               text,
  photo_url           text,
  tags                text[]      not null default '{}',
  allergy_flags       text[]      not null default '{}',
  is_favorite         boolean     not null default false,
  is_public           boolean     not null default false,
  rating              int         check (rating between 1 and 5),
  times_made          int         not null default 0,
  last_made_at        timestamptz,
  source_url          text,
  ai_generated        boolean     not null default false,
  estimated_cost_cents int,
  created_by          uuid        references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_family_recipes_family on public.family_recipes(family_id, category);

alter table public.family_recipes enable row level security;
drop policy if exists "family members can manage recipes" on public.family_recipes;
create policy "family members can manage recipes"
  on public.family_recipes for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Shopping Lists (multi-store) ─────────────────────────────
-- Extends existing grocery_lists / grocery_items with richer metadata.
-- We add columns if not present, then add the new family_shopping_lists
-- table for lists beyond the default grocery list.

alter table public.grocery_lists
  add column if not exists store       text,
  add column if not exists list_icon   text default '🛒',
  add column if not exists list_color  text default '#7c5dfa',
  add column if not exists sort_order  int  default 0,
  add column if not exists archived_at timestamptz;

alter table public.grocery_items
  add column if not exists quantity_unit  text,
  add column if not exists price_cents    int,
  add column if not exists assigned_to_id uuid references auth.users(id) on delete set null,
  add column if not exists note           text,
  add column if not exists sort_order     int default 0;

-- ── Seed default conversations if not present ─────────────────
-- (families get a "Family Chat" group conversation on first use via the app)

-- Notify trigger for last_message_at
create or replace function public.update_conversation_last_message()
returns trigger language plpgsql security definer as $$
begin
  update public.family_conversations
  set last_message_at = NEW.created_at, updated_at = now()
  where id = NEW.conversation_id;
  return NEW;
end;
$$;

drop trigger if exists trg_update_conversation_last_message on public.family_messages;
create trigger trg_update_conversation_last_message
  after insert on public.family_messages
  for each row execute function public.update_conversation_last_message();
