-- FamilyOS :: 0143 AI feedback — the "Why this?" learning loop (T7)
-- ----------------------------------------------------------------------------
-- The "Why this?" affordance shows a recommendation's reason + inputs and lets
-- the family respond: Helpful / Not helpful, dismiss, undo, or adjust. Those
-- responses are captured here as an append-only, family-scoped signal log so
-- the AI surfaces can learn what lands (and a future model-refresh can weigh it).
--
-- One table, append-only (no updates → no updated_at). Family-scoped RLS via
-- public.is_family_member. Additive + idempotent. Validated on PG16.

create table if not exists public.ai_feedback (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who responded
  surface     text not null
                check (surface in ('insight','autopilot','agent','voting','decision','briefing')),
  ref_kind    text,           -- the recommendation's sub-type (e.g. 'groceries', 'conflict')
  ref_id      text,           -- stable id of the specific recommendation
  signal      text not null
                check (signal in ('helpful','not_helpful','dismissed','undo','adjusted')),
  reason      text,           -- snapshot of the rationale shown at feedback time
  note        text,           -- optional free-text (for 'adjusted')
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ai_feedback_family on public.ai_feedback(family_id, created_at desc);
create index if not exists idx_ai_feedback_ref    on public.ai_feedback(family_id, surface, ref_id);

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.ai_feedback enable row level security';
  execute 'drop policy if exists ai_feedback_select on public.ai_feedback';
  execute 'create policy ai_feedback_select on public.ai_feedback for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_insert on public.ai_feedback';
  execute 'create policy ai_feedback_insert on public.ai_feedback for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_update on public.ai_feedback';
  execute 'create policy ai_feedback_update on public.ai_feedback for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_delete on public.ai_feedback';
  execute 'create policy ai_feedback_delete on public.ai_feedback for delete using (public.is_family_member(family_id))';
end $$;
