-- ============================================================
-- Migration 0008: Super Administrator (site-wide)
-- A super admin is identified by email, independent of family
-- membership — they oversee the whole site, not a single household.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.super_admins (
  email      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS is enabled with NO policies on purpose: no client (including the
-- super admin's own session) may SELECT/INSERT/UPDATE/DELETE this table
-- directly. The only way in is the SECURITY DEFINER function below,
-- which only ever reveals a true/false answer about the caller.
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins
    WHERE email = lower(coalesce(auth.jwt()->>'email', ''))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.super_admins (email)
VALUES ('daniel.hughen@gmail.com')
ON CONFLICT (email) DO NOTHING;
