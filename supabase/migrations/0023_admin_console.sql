-- ============================================================
-- Migration 0015: Admin console support tables
--   app_settings        — persisted platform/system settings (key/value)
--   system_backups      — logged backup events + their metrics
--   admin_integrations  — third-party integration registry + status
--
-- These are SITE-ADMIN tables: RLS is enabled with NO policies, so no client
-- session can read/write them directly. The admin console reaches them only
-- through the service-role client (gated by the super-admin check in
-- admin/layout.tsx) — exactly like support_tickets (migration 0012).
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Settings (key/value) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- ── Backup events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'full',          -- full | incremental
  status text NOT NULL DEFAULT 'completed',    -- completed | warning | failed | running
  size_bytes bigint NOT NULL DEFAULT 0,
  location text,
  row_counts jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_system_backups_created ON public.system_backups(created_at DESC);
ALTER TABLE public.system_backups ENABLE ROW LEVEL SECURITY;

-- ── Integration registry ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'Other',
  status text NOT NULL DEFAULT 'available',     -- connected | issue | disconnected | available
  config jsonb NOT NULL DEFAULT '{}',
  last_sync_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS set_admin_integrations_updated ON public.admin_integrations;
CREATE TRIGGER set_admin_integrations_updated BEFORE UPDATE ON public.admin_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE public.admin_integrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done — 3 admin-only tables (service-role access only).
-- ============================================================
