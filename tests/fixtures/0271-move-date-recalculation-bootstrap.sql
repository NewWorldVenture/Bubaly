-- 0271 isolated CI bootstrap, consumed before the actual 0245 and 0271 files.
-- The combined stdin stream is ONE transaction: BEGIN here, ROLLBACK at the
-- end of 0271-move-date-recalculation-runtime.sql. No imports or service startup.
-- Only the parent's fresh PostgreSQL 17 GitHub Actions service may run this.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $guard$
BEGIN
  IF pg_catalog.current_database() <> 'bubaly_move_recalc_ci'
    OR CURRENT_USER <> 'postgres'
    OR pg_catalog.to_regclass('public.moves') IS NOT NULL
    OR pg_catalog.to_regclass('auth.users') IS NOT NULL
    OR pg_catalog.to_regclass('public.families') IS NOT NULL
    OR pg_catalog.to_regclass('public.family_members') IS NOT NULL
  THEN
    RAISE EXCEPTION '0269 fixture refuses a nonfresh or unowned database';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer
    NOT BETWEEN 170000 AND 179999
  THEN
    RAISE EXCEPTION '0269 fixture requires the isolated PostgreSQL 17 service';
  END IF;
END;
$guard$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION '0269 fixture refuses privileged client roles';
  END IF;
END;
$roles$;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text
);

-- Minimal identity schema matching the fields consumed by the actual RPC,
-- source foreign keys, and policies. This is synthetic test data infrastructure.
CREATE TYPE public.member_role AS ENUM ('parent', 'adult', 'child');
CREATE TABLE public.families (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  avatar_url text,
  timezone text NOT NULL DEFAULT 'UTC',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE TABLE public.family_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'adult',
  display_name text NOT NULL,
  color text DEFAULT '#6366f1',
  birthday date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (family_id, user_id)
);

CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

CREATE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.is_family_member(p_family_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.family_members AS member
    WHERE member.family_id = p_family_id
      AND member.user_id = auth.uid()
      AND member.is_active IS TRUE
  )
$function$;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_family_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_family_member(uuid) TO authenticated;
GRANT SELECT ON TABLE public.families, public.family_members TO authenticated;

ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_families_read ON public.families
  FOR SELECT TO authenticated USING (public.is_family_member(id));
CREATE POLICY fixture_members_read ON public.family_members
  FOR SELECT TO authenticated USING (public.is_family_member(family_id));

-- Supply normal application table access for 0245. Its actual policies still
-- govern every client DML operation. Actual 0269 explicitly revokes these
-- inherited write privileges on its history table; runtime never regrants them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

-- The parent now concatenates the exact checked-out 0245 and 0271 migrations.
-- The separate concurrency fixture commits synthetic setup for other sessions;
-- only that disposable CI service is allowed to retain it until job teardown.
