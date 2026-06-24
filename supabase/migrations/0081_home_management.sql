-- ============================================================
-- Migration 0080: Home Management — Tier-9 gap features
-- Four family-scoped tables completing the Home Management tier:
--   utility_bills        — Utility Tracking (monitor costs over time)
--   household_info       — Household Binder (digital command center: wifi, codes,
--                          shutoffs, policies, emergency info; sensitive masking)
--   home_security_events — Security Alerts (event log + open/resolved)
--   smart_devices        — Smart Home Integration (unified device registry/status)
-- All RLS family-scoped via is_family_member(family_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.utility_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'electric'
                 CHECK (kind IN ('electric','gas','water','sewer','trash','internet','phone','cable','other')),
  provider     text,
  period_month date NOT NULL DEFAULT current_date,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  usage        numeric(12,2),
  unit         text,
  note         text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utility_bills_family ON public.utility_bills (family_id, kind, period_month DESC);

CREATE TABLE IF NOT EXISTS public.household_info (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  category     text NOT NULL DEFAULT 'other'
                 CHECK (category IN ('wifi','emergency','shutoff','code','insurance','contact','instruction','account','other')),
  label        text NOT NULL,
  value        text,
  note         text,
  is_sensitive boolean NOT NULL DEFAULT false,
  sort         integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_info_family ON public.household_info (family_id, category, sort);

CREATE TABLE IF NOT EXISTS public.home_security_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'alert'
                 CHECK (kind IN ('alarm','camera','door','window','motion','smoke','water_leak','alert','test','breach','other')),
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title       text NOT NULL,
  detail      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved    boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_security_family ON public.home_security_events (family_id, resolved, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.smart_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'other'
                 CHECK (type IN ('light','lock','thermostat','camera','sensor','plug','hub','speaker','doorbell','vacuum','other')),
  room        text,
  brand       text,
  integration text NOT NULL DEFAULT 'manual'
                 CHECK (integration IN ('homekit','google','alexa','smartthings','matter','manual','other')),
  status      text NOT NULL DEFAULT 'unknown' CHECK (status IN ('online','offline','unknown')),
  last_state  text,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smart_devices_family ON public.smart_devices (family_id, room);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['utility_bills','household_info','home_security_events','smart_devices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;
