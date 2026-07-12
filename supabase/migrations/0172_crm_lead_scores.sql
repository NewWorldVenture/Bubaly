-- FamilyOS :: 0172 — Transparent lead scores (visitor-intelligence gap #14)
--
-- The signals existed (mkt_visitors sessions, touchpoint conversions, consent,
-- demo, progressive profile, lifecycle) but there was no visible score. This
-- persists a per-contact 0–100 score + band + the itemized FACTOR LEDGER (jsonb
-- array of {key,label,points}) so the score is explainable, sortable, and
-- surfaced in the admin console. Scoring logic is pure in
-- `lib/marketing/contact-score.ts` (tested); recompute lives in
-- `lib/marketing/contact-score-compute.ts`.
--
-- Additive + idempotent. Admin/service-role only (RLS on, no public policy).

create table if not exists public.crm_lead_scores (
  contact_id  uuid primary key references public.crm_contacts(id) on delete cascade,
  score       int  not null default 0,
  band        text not null default 'cold',
  factors     jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists idx_crm_lead_scores_score on public.crm_lead_scores (score desc);

-- Read through the service role only (the admin console). RLS on with no policy
-- means no anon/authenticated access — the service role bypasses RLS.
alter table public.crm_lead_scores enable row level security;
