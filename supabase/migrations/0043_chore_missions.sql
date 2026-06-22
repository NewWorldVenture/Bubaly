-- ============================================================
-- Migration 0043: Family Missions — AI chore proof, validation, disputes,
-- and gamification. EXTENDS the existing chores / chore_assignments / rewards
-- system (migrations 0002 + 0028); it does not replace it.
--
-- Adds:
--   * Reward/AI/safety config columns on chores.
--   * AI score + dispute flag on chore_assignments.
--   * chore_submissions      — a kid's photo/video proof for an assignment.
--   * chore_ai_validations   — structured AI verdict for a submission.
--   * chore_disputes         — kid "ask a parent" / retake flow.
--   * chore_approval_events  — append-only audit of parent decisions.
--   * kid_progress           — per-member XP, level, and streaks.
--   * badges / member_badges — gamification catalog + awards.
--   * storage bucket 'chore-proof' (private) for proof media.
--
-- All point/cash mutations still flow through the existing approval path;
-- AI never auto-pays without the parent's configured auto-approve threshold.
-- ============================================================

-- ---------- Config columns on chores ----------
ALTER TABLE public.chores
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS difficulty         text NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy','medium','hard')),
  ADD COLUMN IF NOT EXISTS est_minutes        integer,
  ADD COLUMN IF NOT EXISTS proof_required      text NOT NULL DEFAULT 'none'
    CHECK (proof_required IN ('none','photo','video','before_after')),
  ADD COLUMN IF NOT EXISTS reward_mode         text NOT NULL DEFAULT 'fixed_points'
    CHECK (reward_mode IN ('fixed_cash','fixed_points','ai_cash','ai_points','prize','responsibility')),
  ADD COLUMN IF NOT EXISTS cash_cents          integer,
  ADD COLUMN IF NOT EXISTS cash_min_cents      integer,
  ADD COLUMN IF NOT EXISTS cash_max_cents      integer,
  ADD COLUMN IF NOT EXISTS points_min          integer,
  ADD COLUMN IF NOT EXISTS points_max          integer,
  ADD COLUMN IF NOT EXISTS auto_approve_score  integer,   -- NULL = always require parent
  ADD COLUMN IF NOT EXISTS safety_level        text NOT NULL DEFAULT 'none'
    CHECK (safety_level IN ('none','caution','parent_required')),
  ADD COLUMN IF NOT EXISTS instructions        text,
  ADD COLUMN IF NOT EXISTS example_image_url   text,
  ADD COLUMN IF NOT EXISTS icon                text,
  ADD COLUMN IF NOT EXISTS is_active           boolean NOT NULL DEFAULT true;

-- ---------- AI score + dispute flag on assignments ----------
ALTER TABLE public.chore_assignments
  ADD COLUMN IF NOT EXISTS ai_score   integer,
  ADD COLUMN IF NOT EXISTS cash_awarded_cents integer,
  ADD COLUMN IF NOT EXISTS disputed   boolean NOT NULL DEFAULT false;

-- ---------- Submissions (proof) ----------
CREATE TABLE IF NOT EXISTS public.chore_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.chore_assignments(id) ON DELETE CASCADE,
  chore_id      uuid REFERENCES public.chores(id) ON DELETE SET NULL,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'photo'
                  CHECK (kind IN ('none','photo','video','before_after')),
  media_paths   text[] NOT NULL DEFAULT '{}',   -- storage object paths (private)
  note          text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ai_reviewed','approved','needs_improvement','rejected','parent_review','disputed')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_family ON public.chore_submissions (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_assignment ON public.chore_submissions (assignment_id);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_status ON public.chore_submissions (family_id, status);

-- ---------- AI validation verdicts ----------
CREATE TABLE IF NOT EXISTS public.chore_ai_validations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id               uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  submission_id           uuid NOT NULL REFERENCES public.chore_submissions(id) ON DELETE CASCADE,
  status                  text NOT NULL
                            CHECK (status IN ('approved','needs_improvement','unclear','rejected','parent_review_required')),
  quality_score           integer,    -- 0..100
  confidence              integer,    -- 0..100
  recommended_reward_type text CHECK (recommended_reward_type IN ('cash','points','prize','none')),
  recommended_reward_amount numeric(10,2),
  kid_feedback            text,
  parent_summary          text,
  detected_issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_flags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_parent_review     boolean NOT NULL DEFAULT true,
  model                   text,
  is_fallback             boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_ai_validations_sub ON public.chore_ai_validations (submission_id);

-- ---------- Disputes (kid asks a parent) ----------
CREATE TABLE IF NOT EXISTS public.chore_disputes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.chore_submissions(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  reason        text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','resolved','cancelled')),
  resolution    text,
  resolved_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_disputes_family ON public.chore_disputes (family_id, status);

-- ---------- Approval audit (append-only) ----------
CREATE TABLE IF NOT EXISTS public.chore_approval_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES public.chore_assignments(id) ON DELETE CASCADE,
  submission_id uuid REFERENCES public.chore_submissions(id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  action        text NOT NULL
                  CHECK (action IN ('submit','ai_validate','approve','adjust','reject','redo','dispute','resolve','auto_approve')),
  points_awarded integer,
  cash_cents    integer,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_approval_events_assignment ON public.chore_approval_events (assignment_id, created_at);

-- ---------- Per-member gamification progress ----------
CREATE TABLE IF NOT EXISTS public.kid_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL UNIQUE REFERENCES public.family_members(id) ON DELETE CASCADE,
  xp              integer NOT NULL DEFAULT 0,
  level           integer NOT NULL DEFAULT 1,
  current_streak  integer NOT NULL DEFAULT 0,
  longest_streak  integer NOT NULL DEFAULT 0,
  last_activity   date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kid_progress_family ON public.kid_progress (family_id);

-- ---------- Badges catalog (global, read-only) + awards ----------
CREATE TABLE IF NOT EXISTS public.badges (
  id          text PRIMARY KEY,           -- stable slug, e.g. 'first_chore'
  name        text NOT NULL,
  description text,
  icon        text,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.member_badges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  badge_id    text NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_member_badges_member ON public.member_badges (member_id);

-- Seed a starter badge catalog (idempotent).
INSERT INTO public.badges (id, name, description, icon, sort) VALUES
  ('first_chore',   'First Mission',   'Completed your very first chore.',        '🎯', 10),
  ('streak_3',      'On a Roll',       'Three days in a row.',                    '🔥', 20),
  ('streak_7',      'Week Warrior',    'Seven days in a row.',                    '⚡', 30),
  ('ten_done',      'Double Digits',   'Completed ten chores.',                   '🏅', 40),
  ('perfect_score', 'Perfectionist',   'Earned a 100 quality score from the AI.', '⭐', 50),
  ('helper',        'Team Player',     'Helped on a family quest.',               '🤝', 60),
  ('level_5',       'Rising Star',     'Reached level 5.',                        '🌟', 70)
ON CONFLICT (id) DO NOTHING;

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['chore_submissions','chore_ai_validations','chore_disputes','kid_progress'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS ----------
ALTER TABLE public.chore_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_ai_validations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_disputes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_approval_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kid_progress           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badges                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_badges          ENABLE ROW LEVEL SECURITY;

-- Family members manage their family's submissions/disputes/progress/badges.
DROP POLICY IF EXISTS chore_submissions_all ON public.chore_submissions;
CREATE POLICY chore_submissions_all ON public.chore_submissions
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS chore_disputes_all ON public.chore_disputes;
CREATE POLICY chore_disputes_all ON public.chore_disputes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS kid_progress_all ON public.kid_progress;
CREATE POLICY kid_progress_all ON public.kid_progress
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS member_badges_all ON public.member_badges;
CREATE POLICY member_badges_all ON public.member_badges
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- AI validations + approval audit are readable by the family, written by the
-- service-role engine (server actions), so SELECT only for members.
DROP POLICY IF EXISTS chore_ai_validations_select ON public.chore_ai_validations;
CREATE POLICY chore_ai_validations_select ON public.chore_ai_validations
  FOR SELECT TO authenticated USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS chore_approval_events_select ON public.chore_approval_events;
CREATE POLICY chore_approval_events_select ON public.chore_approval_events
  FOR SELECT TO authenticated USING (public.is_family_member(family_id));

-- Badge catalog is world-readable to any signed-in user.
DROP POLICY IF EXISTS badges_read ON public.badges;
CREATE POLICY badges_read ON public.badges
  FOR SELECT TO authenticated USING (true);

-- ---------- Private storage bucket for proof media ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chore-proof', 'chore-proof', false, 52428800) -- 50 MB (short videos)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Family can read chore proof" ON storage.objects;
CREATE POLICY "Family can read chore proof" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "Family can upload chore proof" ON storage.objects;
CREATE POLICY "Family can upload chore proof" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "Family can delete chore proof" ON storage.objects;
CREATE POLICY "Family can delete chore proof" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));
