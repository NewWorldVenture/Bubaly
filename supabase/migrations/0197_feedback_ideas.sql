-- ============================================================================
-- 0197 · Feedback / Idea Board — "Let's make life easier—together".
--
-- A product-feedback board (Canny-style) where any signed-in member can post an
-- idea, upvote the ideas they want built, and comment. This is a PLATFORM-WIDE
-- board (not family-scoped): ideas and votes are shared across every household so
-- the whole community's demand steers what we build next. Statuses move an idea
-- through our pipeline: under_review → planned → in_progress → shipped.
--
-- RLS model (global board):
--   • ideas    — SELECT for any authenticated user; INSERT own row (author_id =
--                auth.uid()). No public UPDATE/DELETE: status transitions are made
--                by the platform super-admin via the service role.
--   • votes    — SELECT any authenticated; INSERT/DELETE only your own vote. One
--                vote per (idea, user) via a unique index → a clean toggle.
--   • comments — SELECT any authenticated; INSERT own row.
--
-- vote_count / comment_count are denormalized counters kept exact by triggers so
-- the board sorts/renders without N+1 aggregation. Additive + idempotent
-- (IF NOT EXISTS + guarded policies). Requires: families, family_members,
-- set_updated_at (0000-era), gen_random_uuid.
-- ============================================================================

-- ── Ideas ────────────────────────────────────────────────────────────────────
create table if not exists public.feedback_ideas (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid references auth.users(id) on delete set null,
  author_name   text not null default 'A Bubaly family',
  family_id     uuid references public.families(id) on delete set null,   -- context only
  title         text not null,
  problem       text,                                                     -- "What problem would this solve?"
  body          text,                                                     -- "Your idea"
  category      text not null default 'other'
                  check (category in ('calendar','tasks','meals','chores','finance',
                                      'communication','marketplace','ai_assistant',
                                      'kids','health','mobile','other')),
  impact        text not null default 'helpful'
                  check (impact in ('nice_to_have','helpful','game_changer')),
  audience      text not null default 'me'
                  check (audience in ('me','others','everyone')),
  image_url     text,
  status        text not null default 'under_review'
                  check (status in ('under_review','planned','in_progress','shipped','declined')),
  admin_note    text,                                                     -- optional public roadmap note
  vote_count    integer not null default 0,
  comment_count integer not null default 0,
  pinned        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_feedback_ideas_status  on public.feedback_ideas(status, vote_count desc);
create index if not exists idx_feedback_ideas_ranked  on public.feedback_ideas(pinned desc, vote_count desc, created_at desc);
create index if not exists idx_feedback_ideas_author  on public.feedback_ideas(author_id);
create index if not exists idx_feedback_ideas_category on public.feedback_ideas(category);

-- ── Votes (one per user per idea) ────────────────────────────────────────────
create table if not exists public.feedback_votes (
  id         uuid primary key default gen_random_uuid(),
  idea_id    uuid not null references public.feedback_ideas(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_feedback_votes_user on public.feedback_votes(idea_id, user_id);
create index if not exists idx_feedback_votes_idea on public.feedback_votes(idea_id);

-- ── Comments ─────────────────────────────────────────────────────────────────
create table if not exists public.feedback_comments (
  id          uuid primary key default gen_random_uuid(),
  idea_id     uuid not null references public.feedback_ideas(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  author_name text not null default 'A Bubaly family',
  is_team     boolean not null default false,                            -- rendered as a team reply
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_feedback_comments_idea on public.feedback_comments(idea_id, created_at);

-- ── Denormalized-counter triggers ────────────────────────────────────────────
create or replace function public.feedback_bump_vote_count() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.feedback_ideas set vote_count = vote_count + 1 where id = new.idea_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.feedback_ideas set vote_count = greatest(0, vote_count - 1) where id = old.idea_id;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists trg_feedback_vote_count on public.feedback_votes;
create trigger trg_feedback_vote_count
  after insert or delete on public.feedback_votes
  for each row execute function public.feedback_bump_vote_count();

create or replace function public.feedback_bump_comment_count() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.feedback_ideas set comment_count = comment_count + 1 where id = new.idea_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.feedback_ideas set comment_count = greatest(0, comment_count - 1) where id = old.idea_id;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists trg_feedback_comment_count on public.feedback_comments;
create trigger trg_feedback_comment_count
  after insert or delete on public.feedback_comments
  for each row execute function public.feedback_bump_comment_count();

drop trigger if exists trg_feedback_ideas_updated_at on public.feedback_ideas;
create trigger trg_feedback_ideas_updated_at before update on public.feedback_ideas
  for each row execute function public.set_updated_at();

drop trigger if exists trg_feedback_comments_updated_at on public.feedback_comments;
create trigger trg_feedback_comments_updated_at before update on public.feedback_comments
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.feedback_ideas    enable row level security;
alter table public.feedback_votes    enable row level security;
alter table public.feedback_comments enable row level security;

do $$ begin
  -- Ideas: everyone signed in reads the board; you may only insert as yourself.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_ideas' and policyname='feedback_ideas_select') then
    create policy feedback_ideas_select on public.feedback_ideas for select using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_ideas' and policyname='feedback_ideas_insert') then
    create policy feedback_ideas_insert on public.feedback_ideas for insert with check (author_id = auth.uid());
  end if;
  -- No UPDATE/DELETE policy: status transitions are service-role (super-admin) only.

  -- Votes: read all (for counts); write only your own.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_votes' and policyname='feedback_votes_select') then
    create policy feedback_votes_select on public.feedback_votes for select using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_votes' and policyname='feedback_votes_insert') then
    create policy feedback_votes_insert on public.feedback_votes for insert with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_votes' and policyname='feedback_votes_delete') then
    create policy feedback_votes_delete on public.feedback_votes for delete using (user_id = auth.uid());
  end if;

  -- Comments: read all; insert your own.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_comments' and policyname='feedback_comments_select') then
    create policy feedback_comments_select on public.feedback_comments for select using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feedback_comments' and policyname='feedback_comments_insert') then
    create policy feedback_comments_insert on public.feedback_comments for insert with check (author_id = auth.uid());
  end if;
end $$;

-- ── Storage bucket for idea attachments (public read; own-folder writes) ──────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-attachments', 'feedback-attachments', true, 10485760,  -- 10 MB
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/avif'];

drop policy if exists "Feedback attachments are publicly readable" on storage.objects;
create policy "Feedback attachments are publicly readable" on storage.objects
  for select using (bucket_id = 'feedback-attachments');

drop policy if exists "Users upload their own feedback attachment" on storage.objects;
create policy "Users upload their own feedback attachment" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'feedback-attachments' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "Users delete their own feedback attachment" on storage.objects;
create policy "Users delete their own feedback attachment" on storage.objects
  for delete to authenticated
  using (bucket_id = 'feedback-attachments' and auth.uid()::text = (storage.foldername(name))[1]);
