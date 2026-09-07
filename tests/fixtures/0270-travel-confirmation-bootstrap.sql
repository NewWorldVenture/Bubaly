\set ON_ERROR_STOP on
SET client_min_messages = warning;
SET timezone = 'UTC';

DO $$
BEGIN
  IF current_database() <> 'bubaly_travel_import_ci'
     OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  THEN
    RAISE EXCEPTION 'This fixture requires its disposable PostgreSQL 17 Unix-socket service';
  END IF;
END
$$;

-- Synthetic identities only. The vacation tables and import RPC are supplied
-- exclusively by the checked-out 0070 and 0270 migrations, never by this file.
CREATE ROLE anon NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER BYPASSRLS;
CREATE SCHEMA auth;
CREATE EXTENSION pgcrypto WITH SCHEMA public;
CREATE TYPE public.member_role AS ENUM ('parent', 'adult', 'teen', 'child', 'caregiver', 'guest');
CREATE TYPE public.ai_role AS ENUM ('user', 'assistant', 'system', 'tool');

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.families (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.family_members (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES public.families(id),
  user_id uuid REFERENCES auth.users(id),
  role public.member_role NOT NULL,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.documents (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES public.families(id)
);

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE FUNCTION public.is_family_member(p_family_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND is_active
  )
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT SELECT ON public.families, public.family_members TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), public.is_family_member(uuid) TO anon, authenticated;
-- Model broad API-role defaults so 0270 must actually revoke inherited writes.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;

INSERT INTO auth.users(id)
SELECT ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
FROM generate_series(1, 8) AS n;
INSERT INTO public.families(id, name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Synthetic CI family A'),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic CI family B');
INSERT INTO public.family_members(id, family_id, user_id, role, display_name, is_active) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'parent', 'CI parent A', true),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'adult', 'CI adult A', true),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'child', 'CI child A', true),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004', 'parent', 'CI parent B', true),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'parent', 'CI inactive parent', false),
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'child', 'CI parent A is child in B', true),
  ('30000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000007', 'caregiver', 'CI caregiver', true),
  ('30000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000008', 'teen', 'CI teen', true);
