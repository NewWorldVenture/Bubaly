-- Bubaly :: 0265 Where a family memory came from, and when it stops being true
-- ----------------------------------------------------------------------------
-- 0123 gave `family_facts` no provenance at all, so the repo carried it in the
-- `notes` TEXT column: a fact Bubaly inferred has notes beginning "Learned by
-- Bubaly" (`AI_MEMORY_MARKER` in lib/services/memory). Two failure modes a
-- family would actually hit:
--
--   * "Clear what Bubaly learned" runs `notes ilike 'Learned by Bubaly%'`, so a
--     person who writes that sentence in their OWN note loses their own fact.
--   * `rememberConfirmed` overwrites `notes` when a person restates a fact the
--     household already holds. The marker is gone, the fact is now
--     indistinguishable from one a person typed, and the same clear silently
--     misses it forever. That is provenance destroyed by ordinary use.
--
-- So provenance becomes a column. With it:
--
--   * `confidence`, which the inbox has computed since 0126 and `confirmFact`
--     threw away at the moment of acceptance — how sure Bubaly was is exactly
--     what a person wants when deciding whether to keep a belief.
--   * `expires_at`, which nothing here has ever had. A child's shoe size, a
--     school year, a policy number: facts with a shelf life. A stale one
--     steering a plan is worse than no fact at all, because it looks certain.
--
-- DELIBERATELY NOT ADDED: `confirmed`. Everything in this table is confirmed by
-- construction — `rememberFact` routes every non-person source to
-- `family_playbook_suggestions`, and `confirmFact` is the only thing that moves
-- a row across. A column that is always true is an invitation for some later
-- writer to put false in it and break the invariant the whole design rests on.
-- The two tables are the confirmed/unconfirmed distinction; a flag would be a
-- second, weaker copy of it.
--
-- Additive + idempotent. No policy changes: 0264 owns this table's RLS.

alter table public.family_facts
  add column if not exists source      text,
  add column if not exists confidence  smallint,
  add column if not exists expires_at  timestamptz;

-- Backfill BEFORE the not-null default lands, so existing rows are classified
-- by the marker they actually carry rather than all defaulting to 'user'.
-- Idempotent: a re-run reaches the same answer for the same notes.
update public.family_facts
   set source = case when notes like 'Learned by Bubaly%' then 'ai_conversation' else 'user' end
 where source is null;

alter table public.family_facts
  alter column source set default 'user',
  alter column source set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.family_facts'::regclass and conname = 'family_facts_source_check'
  ) then
    alter table public.family_facts
      add constraint family_facts_source_check
      check (source in ('user', 'ai_conversation', 'ai_inferred', 'import'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.family_facts'::regclass and conname = 'family_facts_confidence_check'
  ) then
    -- 0..100, matching `family_playbook_suggestions.confidence` so a value
    -- survives the move across unchanged. Null is "nobody scored this", which
    -- is what a fact a person typed should say.
    alter table public.family_facts
      add constraint family_facts_confidence_check
      check (confidence is null or (confidence between 0 and 100));
  end if;
end $$;

-- "Everything Bubaly learned" is now one indexed predicate rather than a
-- prefix scan over free text.
create index if not exists idx_family_facts_source on public.family_facts(family_id, source);
-- Partial: only a minority of facts ever expire, and the sweep only wants those.
create index if not exists idx_family_facts_expiry on public.family_facts(family_id, expires_at)
  where expires_at is not null;
