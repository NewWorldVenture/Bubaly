-- ============================================================================
-- 0165 · Family App Store — open catalog of AI-powered extensions families can
-- install. Two tables:
--   family_apps         — the global catalog (reference data; readable by any
--                         signed-in user, written by admins/seed).
--   family_app_installs — which apps a family has installed + per-family config;
--                         family-scoped RLS via public.is_family_member.
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.family_apps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  tagline      text,
  description  text,
  category     text NOT NULL DEFAULT 'other',
  emoji        text,
  publisher    text NOT NULL DEFAULT 'Bubaly',
  capabilities text[] NOT NULL DEFAULT '{}',
  is_official  boolean NOT NULL DEFAULT false,
  is_ai        boolean NOT NULL DEFAULT true,
  rating       numeric(2,1),                          -- 0.0–5.0 catalog rating
  install_count integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'published'
                 CHECK (status IN ('published','beta','coming_soon','retired')),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_apps_category ON public.family_apps (category, sort_order);
CREATE INDEX IF NOT EXISTS idx_family_apps_status   ON public.family_apps (status);

CREATE TABLE IF NOT EXISTS public.family_app_installs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  app_id       uuid NOT NULL REFERENCES public.family_apps(id) ON DELETE CASCADE,
  installed_by uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  enabled      boolean NOT NULL DEFAULT true,
  config       jsonb NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_family_app_installs_family ON public.family_app_installs (family_id, enabled);

-- updated_at triggers
DROP TRIGGER IF EXISTS set_family_apps_updated ON public.family_apps;
CREATE TRIGGER set_family_apps_updated BEFORE UPDATE ON public.family_apps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_family_app_installs_updated ON public.family_app_installs;
CREATE TRIGGER set_family_app_installs_updated BEFORE UPDATE ON public.family_app_installs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: catalog readable by any signed-in user; installs are family-scoped.
ALTER TABLE public.family_apps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_app_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS family_apps_select ON public.family_apps;
CREATE POLICY family_apps_select ON public.family_apps FOR SELECT USING (auth.uid() IS NOT NULL);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_app_installs'] LOOP
    EXECUTE format('drop policy if exists %1$s_select on public.%1$I', t);
    EXECUTE format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    EXECUTE format('drop policy if exists %1$s_insert on public.%1$I', t);
    EXECUTE format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    EXECUTE format('drop policy if exists %1$s_update on public.%1$I', t);
    EXECUTE format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    EXECUTE format('drop policy if exists %1$s_delete on public.%1$I', t);
    EXECUTE format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  END LOOP;
END $$;
