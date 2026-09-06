-- Bubaly :: 0268 A time-bound suggestion stays time-bound once accepted
-- ----------------------------------------------------------------------------
-- 0265 gave `family_facts` an `expires_at` so a coat size or a school term
-- stops steering a plan once it stops being true. It only reached the lane a
-- person writes directly.
--
-- The inbox is where the time-bound facts mostly come from. Bubaly noticing
-- "swim class is Thursdays" is exactly the kind of belief with a shelf life,
-- and every AI-sourced memory goes to `family_playbook_suggestions` first
-- (`rememberFact` routes it there; `confirmFact` is the only way across). The
-- suggestion had nowhere to keep a deadline, so a card offered as "until
-- December" became a permanent fact the moment a parent accepted it — the same
-- discard as the confidence score 0265 rescued, one field over.
--
-- Additive and nullable: existing suggestions have no deadline, which is what
-- they meant.

alter table public.family_playbook_suggestions
  add column if not exists expires_at timestamptz;

comment on column public.family_playbook_suggestions.expires_at is
  'When the suggested fact stops being true. Carried into family_facts.expires_at by confirmFact.';
