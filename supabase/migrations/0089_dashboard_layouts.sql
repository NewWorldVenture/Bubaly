-- ============================================================================
-- Migration 0089: Customizable dashboard layouts (tier-aware quick actions)
-- ----------------------------------------------------------------------------
-- Stores per-user (and family-default) orderings of dashboard quick-action
-- buttons. The fixed "+" (quick_add) and AI buttons are NOT stored here — they
-- are always rendered by the app and can't be removed. Server actions validate
-- every write (tier entitlement, dedupe, max count, no fixed/locked injection);
-- RLS provides family isolation, and per-user ownership is enforced in the
-- action layer (a parent/admin may also manage the family default).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dashboard_layouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE,   -- null = family default
  scope          text NOT NULL DEFAULT 'user' CHECK (scope IN ('user','family')),
  device_context text NOT NULL DEFAULT 'all' CHECK (device_context IN ('all','mobile','tablet','desktop')),
  feature_keys   text[] NOT NULL DEFAULT '{}',                       -- ordered customizable button keys
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
-- one user layout per (user, device) and one family default per (family, device)
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_layout_user ON public.dashboard_layouts (family_id, user_id, device_context) WHERE scope = 'user' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_layout_family ON public.dashboard_layouts (family_id, device_context) WHERE scope = 'family' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_family ON public.dashboard_layouts (family_id, scope);

CREATE TABLE IF NOT EXISTS public.dashboard_layout_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action       text NOT NULL,    -- customized | button_added | button_removed | button_replaced | reordered | reset | locked_feature_clicked | upgrade_cta_clicked | downgrade_adjusted | upgrade_adjusted
  feature_key  text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_events_family ON public.dashboard_layout_events (family_id, created_at DESC);

-- ---- RLS (family isolation) + updated_at trigger ----
ALTER TABLE public.dashboard_layouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage dashboard_layouts" ON public.dashboard_layouts;
CREATE POLICY "Members manage dashboard_layouts" ON public.dashboard_layouts
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_dashboard_layouts_updated_at ON public.dashboard_layouts;
CREATE TRIGGER trg_dashboard_layouts_updated_at BEFORE UPDATE ON public.dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.dashboard_layout_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage dashboard_layout_events" ON public.dashboard_layout_events;
CREATE POLICY "Members manage dashboard_layout_events" ON public.dashboard_layout_events
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================================
-- Done! Customizable, tier-aware dashboard layouts.
-- ============================================================================
