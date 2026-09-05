-- ============================================================
-- Migration 0247: Career Hub — resume, job search, career navigation (TODO-0414)
--   career_profiles   — one per job search (a member can run several over
--                       time): title, headline, skills, target roles, work
--                       mode, salary target, status, active flag.
--   job_applications  — the pipeline: company, role, stage, dates, next step,
--                       salary, source, contact.
--   resume_versions   — resume text per target role with a deterministic ATS
--                       keyword score against the target's keywords.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.career_profiles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id          uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  title              text NOT NULL DEFAULT 'Job search',
  is_active          boolean NOT NULL DEFAULT true,
  headline           text,
  summary            text,
  skills             text[] NOT NULL DEFAULT '{}',
  target_roles       text[] NOT NULL DEFAULT '{}',
  target_keywords    text[] NOT NULL DEFAULT '{}',
  work_mode          text NOT NULL DEFAULT 'any' CHECK (work_mode IN ('remote','hybrid','onsite','any')),
  employment_type    text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time','contract','internship','first_job','any')),
  salary_target_cents integer CHECK (salary_target_cents IS NULL OR salary_target_cents >= 0),
  location           text,
  status             text NOT NULL DEFAULT 'exploring' CHECK (status IN ('exploring','active_search','interviewing','offer','employed','paused')),
  weekly_goal        integer NOT NULL DEFAULT 5 CHECK (weekly_goal BETWEEN 0 AND 100),
  notes              text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_career_profiles_family ON public.career_profiles (family_id, is_active, member_id);

CREATE TABLE IF NOT EXISTS public.job_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES public.career_profiles(id) ON DELETE CASCADE,
  company         text NOT NULL,
  role_title      text NOT NULL,
  stage           text NOT NULL DEFAULT 'saved'
                  CHECK (stage IN ('saved','applied','screening','interview','offer','accepted','rejected','withdrawn')),
  source          text,
  url             text,
  location        text,
  work_mode       text CHECK (work_mode IS NULL OR work_mode IN ('remote','hybrid','onsite')),
  salary_min_cents integer CHECK (salary_min_cents IS NULL OR salary_min_cents >= 0),
  salary_max_cents integer CHECK (salary_max_cents IS NULL OR salary_max_cents >= 0),
  applied_on      date,
  last_activity_on date,
  next_step       text,
  next_step_on    date,
  contact_name    text,
  contact_email   text,
  resume_id       uuid,
  excitement      integer CHECK (excitement IS NULL OR excitement BETWEEN 1 AND 5),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_applications_profile_stage ON public.job_applications (profile_id, stage);
CREATE INDEX IF NOT EXISTS idx_job_applications_family_next ON public.job_applications (family_id, next_step_on);

CREATE TABLE IF NOT EXISTS public.resume_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES public.career_profiles(id) ON DELETE CASCADE,
  title           text NOT NULL,
  target_role     text,
  body            text NOT NULL DEFAULT '',
  keywords        text[] NOT NULL DEFAULT '{}',
  ats_score       integer CHECK (ats_score IS NULL OR ats_score BETWEEN 0 AND 100),
  matched_keywords text[] NOT NULL DEFAULT '{}',
  missing_keywords text[] NOT NULL DEFAULT '{}',
  is_primary      boolean NOT NULL DEFAULT false,
  file_path       text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resume_versions_profile ON public.resume_versions (profile_id, is_primary);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_applications_resume_id_fkey') THEN
    ALTER TABLE public.job_applications ADD CONSTRAINT job_applications_resume_id_fkey FOREIGN KEY (resume_id) REFERENCES public.resume_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['career_profiles','job_applications','resume_versions'];
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
DECLARE tbls text[] := ARRAY['career_profiles','job_applications','resume_versions'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
