-- ============================================================================
-- 0193 · Marketplace Trust & Safety — report a listing.
--
-- Safety is exactly where Craigslist fails and where a family marketplace has to
-- be better. Paired with the safe-meetup hand-off (0190), this gives members a
-- way to flag a listing that's prohibited, a scam, miscategorized, offensive,
-- spam, or a duplicate — and routes it to the platform super-admin moderation
-- queue (/admin/marketplace/reports) where it can be actioned or dismissed.
--
-- Reporter-family-scoped RLS for reads/inserts; resolutions are written by the
-- super-admin via the service role (no public UPDATE policy). One OPEN report
-- per (listing, member) prevents spam. Additive + idempotent. Requires 0120.
-- ============================================================================

create table if not exists public.marketplace_reports (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,   -- reporter's family
  listing_id      uuid not null references public.marketplace_listings(id) on delete cascade,
  reporter_member uuid references public.family_members(id) on delete set null,
  reason          text not null default 'other'
                    check (reason in ('prohibited','scam','miscategorized','offensive','spam','duplicate','other')),
  details         text,
  status          text not null default 'open'
                    check (status in ('open','reviewing','actioned','dismissed')),
  resolution      text,
  reviewed_by     uuid references auth.users(id) on delete set null,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_mkt_reports_status  on public.marketplace_reports(status, created_at desc);
create index if not exists idx_mkt_reports_listing on public.marketplace_reports(listing_id);
-- One OPEN report per member per listing (anti-spam; a resolved one can recur).
create unique index if not exists uq_mkt_reports_open
  on public.marketplace_reports(listing_id, reporter_member) where status in ('open', 'reviewing');

alter table public.marketplace_reports enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_reports' and policyname='mkt_reports_select') then
    create policy mkt_reports_select on public.marketplace_reports for select using (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_reports' and policyname='mkt_reports_insert') then
    create policy mkt_reports_insert on public.marketplace_reports for insert with check (public.is_family_member(family_id));
  end if;
  -- No UPDATE/DELETE policy: only the service role (super-admin moderation) resolves reports.
end $$;

drop trigger if exists trg_mkt_reports_updated_at on public.marketplace_reports;
create trigger trg_mkt_reports_updated_at before update on public.marketplace_reports
  for each row execute function public.set_updated_at();
