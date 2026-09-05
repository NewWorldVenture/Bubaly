-- ============================================================
-- Migration 0246: Home Projects — "Home projects are difficult to manage" (TODO-0413)
--   home_projects      — one row per project: scope, room, kind, status,
--                        priority, budget, dates, DIY vs hired, contractor link.
--   project_materials  — the materials list: quantity, estimated vs actual
--                        cost, purchased flag, where to buy.
--   project_quotes     — contractor quotes to compare: amount, what it
--                        includes, lead time, validity, accepted / declined.
-- Links to the Home & Maintenance contractor book (home_contractors) so a
-- quote can come from a pro the family already uses.
-- Family-owned data: members read/write their own family's rows (RLS).
-- Additive + idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.home_projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title          text NOT NULL,
  description    text,
  room           text,
  kind           text NOT NULL DEFAULT 'repair'
                 CHECK (kind IN ('repair','renovation','upgrade','outdoor','decor','safety','organization','other')),
  status         text NOT NULL DEFAULT 'idea'
                 CHECK (status IN ('idea','planning','quoting','scheduled','in_progress','on_hold','done','cancelled')),
  priority       text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  is_diy         boolean NOT NULL DEFAULT true,
  budget_cents   integer CHECK (budget_cents IS NULL OR budget_cents >= 0),
  labor_cents    integer NOT NULL DEFAULT 0 CHECK (labor_cents >= 0),
  target_start   date,
  target_end     date,
  completed_at   timestamptz,
  owner_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  contractor_id  uuid REFERENCES public.home_contractors(id) ON DELETE SET NULL,
  photo_path     text,
  notes          text,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_projects_family_status ON public.home_projects (family_id, status, priority);

CREATE TABLE IF NOT EXISTS public.project_materials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES public.home_projects(id) ON DELETE CASCADE,
  name               text NOT NULL,
  quantity           numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit               text,
  est_cost_cents     integer CHECK (est_cost_cents IS NULL OR est_cost_cents >= 0),
  actual_cost_cents  integer CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
  is_purchased       boolean NOT NULL DEFAULT false,
  store              text,
  url                text,
  notes              text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_materials_project ON public.project_materials (project_id, is_purchased);
CREATE INDEX IF NOT EXISTS idx_project_materials_family ON public.project_materials (family_id);

CREATE TABLE IF NOT EXISTS public.project_quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES public.home_projects(id) ON DELETE CASCADE,
  contractor_id       uuid REFERENCES public.home_contractors(id) ON DELETE SET NULL,
  contractor_name     text NOT NULL,
  amount_cents        integer NOT NULL CHECK (amount_cents >= 0),
  includes_materials  boolean NOT NULL DEFAULT false,
  lead_time_days      integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  valid_until         date,
  status              text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('requested','received','accepted','declined','expired')),
  received_on         date,
  notes               text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_quotes_project ON public.project_quotes (project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_quotes_family ON public.project_quotes (family_id);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['home_projects','project_materials','project_quotes'];
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
DECLARE tbls text[] := ARRAY['home_projects','project_materials','project_quotes'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN RETURN; END IF;
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
