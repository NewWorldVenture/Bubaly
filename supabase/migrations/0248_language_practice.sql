-- ============================================================
-- Migration 0248: Language Practice — "Learning a language is hard" (TODO-0415)
--   language_goals    — a member learning a language: current and target CEFR
--                       level, weekly-minutes goal, why, active flag.
--   language_sessions — practice sessions: kind, minutes, score, topic,
--                       corrections, date. Feeds streaks and weekly progress.
--   vocab_cards       — spaced-repetition cards (SM-2): term, translation,
--                       example, ease, interval, repetitions, due date, lapses.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.language_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  language_code   text NOT NULL,
  language_label  text NOT NULL,
  current_level   text NOT NULL DEFAULT 'A1' CHECK (current_level IN ('A0','A1','A2','B1','B2','C1','C2')),
  target_level    text NOT NULL DEFAULT 'B1' CHECK (target_level IN ('A1','A2','B1','B2','C1','C2')),
  weekly_minutes  integer NOT NULL DEFAULT 90 CHECK (weekly_minutes BETWEEN 0 AND 3000),
  reason          text,
  started_on      date NOT NULL DEFAULT CURRENT_DATE,
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_language_goals_family ON public.language_goals (family_id, is_active, member_id);

CREATE TABLE IF NOT EXISTS public.language_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  goal_id         uuid NOT NULL REFERENCES public.language_goals(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'vocab'
                  CHECK (kind IN ('conversation','vocab','listening','reading','writing','grammar','lesson','tutor','immersion')),
  minutes         integer NOT NULL DEFAULT 15 CHECK (minutes BETWEEN 1 AND 600),
  score           integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  topic           text,
  corrections     text[] NOT NULL DEFAULT '{}',
  practiced_on    date NOT NULL DEFAULT CURRENT_DATE,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_language_sessions_goal_date ON public.language_sessions (goal_id, practiced_on DESC);
CREATE INDEX IF NOT EXISTS idx_language_sessions_family ON public.language_sessions (family_id, practiced_on DESC);

CREATE TABLE IF NOT EXISTS public.vocab_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  goal_id           uuid NOT NULL REFERENCES public.language_goals(id) ON DELETE CASCADE,
  term              text NOT NULL,
  translation       text NOT NULL,
  example           text,
  part_of_speech    text,
  tags              text[] NOT NULL DEFAULT '{}',
  ease              numeric(4,2) NOT NULL DEFAULT 2.5 CHECK (ease BETWEEN 1.3 AND 4),
  interval_days     integer NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  repetitions       integer NOT NULL DEFAULT 0 CHECK (repetitions >= 0),
  lapses            integer NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  due_on            date NOT NULL DEFAULT CURRENT_DATE,
  last_reviewed_on  date,
  is_suspended      boolean NOT NULL DEFAULT false,
  notes             text,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vocab_cards_goal_due ON public.vocab_cards (goal_id, is_suspended, due_on);
CREATE INDEX IF NOT EXISTS idx_vocab_cards_family ON public.vocab_cards (family_id);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['language_goals','language_sessions','vocab_cards'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['language_goals','language_sessions','vocab_cards'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
