-- Bubaly :: 0284 the family library — podcasts and books
--
-- Subscribe to a feed, stream an episode, keep your place, save the ones you
-- want to keep, and mark what should be available offline.
--
-- Three tables, split along who owns what:
--
--   library_feeds     what the family subscribed to
--   library_items     what is IN those feeds, plus books added by hand
--   library_progress  where each PERSON has got to
--
-- That last split is the one that matters. A household shares a subscription
-- but not a place in an episode: two people listening to the same show must not
-- overwrite each other's position, so progress is keyed per user and nothing
-- about a person's place is stored on the shared row.
--
-- What Bubaly stores is metadata and a URL — a feed's own public address and
-- the file it points at. It hosts no audio and copies no content; playback
-- streams from the publisher, exactly as any podcast app does.

create table if not exists public.library_feeds (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  kind            text not null default 'podcast' check (kind in ('podcast', 'book')),
  title           text not null,
  feed_url        text not null,
  site_url        text,
  image_url       text,
  author          text,
  description     text,
  last_fetched_at timestamptz,
  -- Why the last refresh failed, in words, so a dead feed says so in the list
  -- instead of just going quiet.
  last_error      text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- One subscription per feed per family; a second "subscribe" refreshes instead.
create unique index if not exists uq_library_feed_per_family
  on public.library_feeds(family_id, feed_url);

create table if not exists public.library_items (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  -- Null for a book someone typed in rather than one that came from a feed.
  feed_id          uuid references public.library_feeds(id) on delete cascade,
  kind             text not null default 'episode' check (kind in ('episode', 'book')),
  guid             text not null,
  title            text not null,
  author           text,
  description      text,
  media_url        text,
  page_url         text,
  image_url        text,
  duration_seconds integer check (duration_seconds is null or duration_seconds > 0),
  published_at     timestamptz,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- Refreshing a feed must update the episodes it already has rather than add
-- them again. The guid is the publisher's own identifier for exactly this.
create unique index if not exists uq_library_item_guid
  on public.library_items(family_id, coalesce(feed_id::text, 'manual'), guid);
create index if not exists idx_library_items_recent
  on public.library_items(family_id, published_at desc nulls last);

create table if not exists public.library_progress (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  item_id          uuid not null references public.library_items(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  position_seconds integer not null default 0 check (position_seconds >= 0),
  completed_at     timestamptz,
  saved            boolean not null default false,
  -- The person asked for this offline. Whether the bytes are actually cached is
  -- the browser's business and is read from the Cache API at render time — this
  -- column is the intent, never a claim that the file is there.
  offline          boolean not null default false,
  updated_at       timestamptz not null default now()
);
create unique index if not exists uq_library_progress_per_person
  on public.library_progress(item_id, user_id);
create index if not exists idx_library_progress_saved
  on public.library_progress(family_id, user_id) where saved = true;

do $$
declare t text;
begin
  foreach t in array array['library_feeds', 'library_items', 'library_progress'] loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

alter table public.library_feeds    enable row level security;
alter table public.library_items    enable row level security;
alter table public.library_progress enable row level security;

-- Feeds and items are shared: the household subscribes together.
drop policy if exists library_feeds_rw on public.library_feeds;
create policy library_feeds_rw on public.library_feeds for all
  using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists library_items_rw on public.library_items;
create policy library_items_rw on public.library_items for all
  using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

-- Progress is not. A member reads and writes their OWN row and no one else's,
-- so a shared subscription never means a shared bookmark — or a visible one.
drop policy if exists library_progress_rw on public.library_progress;
create policy library_progress_rw on public.library_progress for all
  using (public.is_family_member(family_id) and user_id = auth.uid())
  with check (public.is_family_member(family_id) and user_id = auth.uid());
