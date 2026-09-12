-- Bubaly :: 0283 assistant links
--
-- Lets a voice assistant — Alexa, Siri via Shortcuts, Google, Home Assistant,
-- anything that can make an HTTPS request — act for one family member.
--
-- The token is a CAPABILITY: holding it is the authorization, exactly like the
-- ICS feed slugs in 0034. The difference, and the reason this table is shaped
-- the way it is, is that an assistant token can WRITE — it creates tasks,
-- events and shopping items. So:
--
--   • only a SHA-256 of the token is stored. The secret is shown once, at
--     creation, and is unrecoverable. A dump of this table hands an attacker
--     nothing replayable.
--   • `token_hash` is not readable by ordinary members even though it is a
--     hash: RLS is row-level, so the column is withheld with a column-level
--     GRANT instead. Members can see that a link exists, its label and its last
--     use; they cannot read the hash.
--   • every use is written to assistant_link_events, so "what did the speaker
--     in the kitchen do" has an answer.

create table if not exists public.assistant_links (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider     text not null default 'generic'
                 check (provider in ('alexa', 'siri', 'google', 'generic')),
  label        text not null,
  token_hash   text not null unique,
  -- The first few characters, in clear, purely so a person can tell two links
  -- apart in a list. Not enough to reconstruct anything.
  token_prefix text not null,
  -- 'ask' reads the day out; 'capture' creates things. A speaker in a shared
  -- room can be given 'ask' alone.
  scopes       text[] not null default array['ask', 'capture'],
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_assistant_links_family on public.assistant_links(family_id);
-- The hot path: one lookup per assistant request, live links only.
create index if not exists idx_assistant_links_live
  on public.assistant_links(token_hash) where revoked_at is null;

create table if not exists public.assistant_link_events (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.assistant_links(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  intent      text not null,
  -- Truncated by the caller. Kept because "why did a task called that appear"
  -- is unanswerable without it.
  utterance   text,
  outcome     text not null check (outcome in ('answered', 'captured', 'refused', 'error')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_assistant_events_link on public.assistant_link_events(link_id, created_at desc);

drop trigger if exists trg_set_updated_at on public.assistant_links;
create trigger trg_set_updated_at before update on public.assistant_links
  for each row execute function public.set_updated_at();

alter table public.assistant_links       enable row level security;
alter table public.assistant_link_events enable row level security;

-- Members see their family's links; only a parent/admin can create or revoke
-- one, because a link is a standing grant to act as the family.
drop policy if exists assistant_links_select on public.assistant_links;
create policy assistant_links_select on public.assistant_links for select
  using (public.is_family_member(family_id));
drop policy if exists assistant_links_insert on public.assistant_links;
create policy assistant_links_insert on public.assistant_links for insert
  with check (public.can_manage_family(family_id));
drop policy if exists assistant_links_update on public.assistant_links;
create policy assistant_links_update on public.assistant_links for update
  using (public.can_manage_family(family_id));
drop policy if exists assistant_links_delete on public.assistant_links;
create policy assistant_links_delete on public.assistant_links for delete
  using (public.can_manage_family(family_id));

drop policy if exists assistant_link_events_select on public.assistant_link_events;
create policy assistant_link_events_select on public.assistant_link_events for select
  using (public.is_family_member(family_id));
-- No insert policy: only the request handler writes here, through the service
-- role. A client that could forge its own audit trail would make the trail
-- worth nothing.

-- Column-level withholding of the secret. RLS decides ROWS; this decides
-- COLUMNS, and the hash needs the second. Re-granting the rest explicitly
-- (rather than `grant select` on the table) is what makes the exclusion stick.
revoke select on public.assistant_links from authenticated, anon;
grant select (
  id, family_id, user_id, provider, label, token_prefix, scopes,
  last_used_at, revoked_at, created_by, created_at, updated_at
) on public.assistant_links to authenticated;
grant insert, update, delete on public.assistant_links to authenticated;
