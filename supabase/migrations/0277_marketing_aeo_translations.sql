-- Bubaly :: 0277 Locale-aware AEO knowledge base
-- ----------------------------------------------------------------------------
-- The Knowledge Center section on every marketing page renders its heading and
-- description through the i18n catalogue, but the questions and answers come
-- straight out of `marketing_aeo_questions`, which holds one English string per
-- row and no locale at all. On a Spanish page that produced a Spanish heading
-- over an English accordion — the site half-translated, which reads worse than
-- either language on its own.
--
-- The content is editorial and admin-maintained, so it cannot move into the
-- message catalogues: an admin edits it in /admin/marketing/aeo and it must
-- keep propagating everywhere. This gives it the missing dimension instead —
-- one row per (question, locale) — and leaves the English text where it is, as
-- the source and the fallback.
--
-- Reading is public for the same reason the parent is: these are published
-- answers, and the public site reads them with the anon key. A translation is
-- visible only when its parent question is published, so unpublishing still
-- hides every language at once.

create table if not exists public.marketing_aeo_question_translations (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.marketing_aeo_questions(id) on delete cascade,
  locale       text not null check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  question     text not null,
  answer       text not null,
  -- How this text was produced, so a machine draft can be told from a reviewed
  -- one and re-run or replaced without guessing.
  source       text not null default 'machine' check (source in ('machine', 'human')),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (question_id, locale)
);

create index if not exists idx_mkt_aeo_tr_locale
  on public.marketing_aeo_question_translations (locale);

drop trigger if exists trg_mkt_aeo_tr_updated_at on public.marketing_aeo_question_translations;
create trigger trg_mkt_aeo_tr_updated_at
  before update on public.marketing_aeo_question_translations
  for each row execute function public.set_updated_at();

alter table public.marketing_aeo_question_translations enable row level security;

-- Public read, gated on the PARENT being published — never on the translation
-- row itself, so there is exactly one place that decides whether an answer is
-- public.
drop policy if exists marketing_aeo_translation_public_read on public.marketing_aeo_question_translations;
create policy marketing_aeo_translation_public_read on public.marketing_aeo_question_translations
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.marketing_aeo_questions q
      where q.id = marketing_aeo_question_translations.question_id
        and q.status = 'published'
    )
  );

grant select on public.marketing_aeo_question_translations to anon, authenticated;

-- Writes stay service-role only: the admin console and the translation job both
-- run with the service key, so no write policy is needed and none is given.
