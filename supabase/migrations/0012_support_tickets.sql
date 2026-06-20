-- ============================================================
-- Migration 0012: Support tickets
-- Backs the Admin Dashboard "Support Overview" panel with real data.
-- Rows are created server-side from the public contact form (service
-- role) and read only by the super admin via the service-role client.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT '',
  email      text NOT NULL,
  subject    text NOT NULL DEFAULT '',
  message    text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  source     text NOT NULL DEFAULT 'contact',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on with NO policies: no client session can read or write directly.
-- Inserts come from the contact API via the service-role client, and the
-- super admin reads via the service-role client in the admin console — both
-- bypass RLS. This keeps support messages off-limits to ordinary users.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Contact-form submissions now land in support_tickets.
-- ============================================================
