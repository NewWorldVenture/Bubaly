-- Bubaly :: 0176 — Community Marketplace v1: Circles (renumbered from 0173)
--
-- Cross-family marketplace, done conservatively. Families form opt-in CIRCLES
-- (neighbors, the school class, the team) via an invite code, then explicitly
-- SHARE individual listings into a circle. Members of that circle can SEE the
-- shared listings — nothing else.
--
-- Security model (deliberate):
--   • Base marketplace RLS is UNTOUCHED. Cross-family visibility is ONE
--     additive SELECT policy on marketplace_listings, scoped to listings the
--     owner explicitly shared into a circle the viewer's family belongs to.
--     All listing WRITES stay family-scoped; offers/orders remain within-family
--     (cross-family transactions are v2 — the feed says "arrange together").
--   • Circle membership rows carry a denormalized family_name snapshot so the
--     feed can attribute an item without exposing the families table.
--   • All circle writes go through ownership-checked SECURITY DEFINER RPCs
--     (create/join/leave) — joining by code must work before you can SELECT
--     the circle, and definer functions pin search_path.
--
-- Additive + idempotent.

create table if not exists public.marketplace_circles (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  emoji              text not null default '🤝',
  join_code          text not null unique,
  created_by_family  uuid not null references public.families(id) on delete cascade,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.marketplace_circle_members (
  id           uuid primary key default gen_random_uuid(),
  circle_id    uuid not null references public.marketplace_circles(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  family_name  text not null,
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (circle_id, family_id)
);

create table if not exists public.marketplace_listing_shares (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  circle_id   uuid not null references public.marketplace_circles(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (listing_id, circle_id)
);

create index if not exists idx_mkt_circle_members_family on public.marketplace_circle_members(family_id);
create index if not exists idx_mkt_circle_members_circle on public.marketplace_circle_members(circle_id);
create index if not exists idx_mkt_listing_shares_circle on public.marketplace_listing_shares(circle_id, created_at desc);
create index if not exists idx_mkt_listing_shares_listing on public.marketplace_listing_shares(listing_id);

drop trigger if exists set_marketplace_circles_updated_at on public.marketplace_circles;
create trigger set_marketplace_circles_updated_at
  before update on public.marketplace_circles
  for each row execute function public.set_updated_at();
drop trigger if exists set_marketplace_circle_members_updated_at on public.marketplace_circle_members;
create trigger set_marketplace_circle_members_updated_at
  before update on public.marketplace_circle_members
  for each row execute function public.set_updated_at();
drop trigger if exists set_marketplace_listing_shares_updated_at on public.marketplace_listing_shares;
create trigger set_marketplace_listing_shares_updated_at
  before update on public.marketplace_listing_shares
  for each row execute function public.set_updated_at();

alter table public.marketplace_circles enable row level security;
alter table public.marketplace_circle_members enable row level security;
alter table public.marketplace_listing_shares enable row level security;

-- ── Reads: members of a circle see the circle, its roster, its shares ────────

drop policy if exists mkt_circles_select on public.marketplace_circles;
create policy mkt_circles_select on public.marketplace_circles
  for select using (exists (
    select 1 from public.marketplace_circle_members m
    where m.circle_id = marketplace_circles.id and public.is_family_member(m.family_id)
  ));

drop policy if exists mkt_circle_members_select on public.marketplace_circle_members;
create policy mkt_circle_members_select on public.marketplace_circle_members
  for select using (exists (
    select 1 from public.marketplace_circle_members me
    where me.circle_id = marketplace_circle_members.circle_id and public.is_family_member(me.family_id)
  ));

drop policy if exists mkt_listing_shares_select on public.marketplace_listing_shares;
create policy mkt_listing_shares_select on public.marketplace_listing_shares
  for select using (exists (
    select 1 from public.marketplace_circle_members me
    where me.circle_id = marketplace_listing_shares.circle_id and public.is_family_member(me.family_id)
  ));

-- ── Share writes: a family shares/unshares ITS OWN listings into ITS circles ─

drop policy if exists mkt_listing_shares_insert on public.marketplace_listing_shares;
create policy mkt_listing_shares_insert on public.marketplace_listing_shares
  for insert with check (
    public.is_family_member(family_id)
    and exists (select 1 from public.marketplace_listings l
                where l.id = listing_id and l.family_id = marketplace_listing_shares.family_id)
    and exists (select 1 from public.marketplace_circle_members me
                where me.circle_id = marketplace_listing_shares.circle_id
                  and me.family_id = marketplace_listing_shares.family_id)
  );

drop policy if exists mkt_listing_shares_delete on public.marketplace_listing_shares;
create policy mkt_listing_shares_delete on public.marketplace_listing_shares
  for delete using (public.is_family_member(family_id));

-- ── THE cross-family read: shared listings become visible to circle members ──

drop policy if exists marketplace_listings_circle_read on public.marketplace_listings;
create policy marketplace_listings_circle_read on public.marketplace_listings
  for select using (exists (
    select 1
    from public.marketplace_listing_shares s
    join public.marketplace_circle_members me on me.circle_id = s.circle_id
    where s.listing_id = marketplace_listings.id
      and public.is_family_member(me.family_id)
  ));

-- ── Circle lifecycle RPCs (SECURITY DEFINER, ownership-checked) ──────────────

create or replace function public.marketplace_create_circle(p_family uuid, p_name text, p_emoji text default '🤝')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_circle uuid;
  v_code   text;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'circle needs a name';
  end if;

  select name into v_name from public.families where id = p_family;
  -- 8-char human-friendly code (no 0/O/1/I), retried on the rare collision.
  loop
    v_code := upper(substr(translate(encode(gen_random_bytes(8), 'base64'), '0O1Il+/=', 'ABCDEFGH'), 1, 8));
    exit when not exists (select 1 from public.marketplace_circles c where c.join_code = v_code);
  end loop;

  insert into public.marketplace_circles (name, emoji, join_code, created_by_family, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_emoji), ''), '🤝'), v_code, p_family, auth.uid())
  returning id into v_circle;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'owner');

  return v_circle;
end $$;

create or replace function public.marketplace_join_circle(p_family uuid, p_code text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_circle uuid;
  v_name   text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;

  select id into v_circle from public.marketplace_circles
  where join_code = upper(trim(p_code));
  if v_circle is null then
    raise exception 'no circle with that code';
  end if;

  select name into v_name from public.families where id = p_family;

  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role)
  values (v_circle, p_family, coalesce(v_name, 'A family'), 'member')
  on conflict (circle_id, family_id) do nothing;

  return v_circle;
end $$;

create or replace function public.marketplace_leave_circle(p_family uuid, p_circle uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
begin
  if not public.is_family_member(p_family) then
    raise exception 'not a member of this family';
  end if;

  select role into v_role from public.marketplace_circle_members
  where circle_id = p_circle and family_id = p_family;
  if v_role is null then return; end if;

  if v_role = 'owner' then
    -- The founding family leaving dissolves the circle (memberships + shares cascade).
    delete from public.marketplace_circles where id = p_circle;
  else
    delete from public.marketplace_circle_members where circle_id = p_circle and family_id = p_family;
    delete from public.marketplace_listing_shares where circle_id = p_circle and family_id = p_family;
  end if;
end $$;
