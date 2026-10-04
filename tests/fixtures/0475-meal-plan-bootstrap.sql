-- Synthetic minimal schema only; actual 0475 migration is applied afterward.
DO $$
BEGIN
  IF current_database() <> 'bubaly_meal_plan_atomic_ci'
     OR current_user <> 'postgres' OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION '0475 bootstrap requires its dedicated synthetic PostgreSQL 17 database';
  END IF;
END $$;

CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.families (id uuid PRIMARY KEY);
CREATE TYPE public.member_role AS ENUM ('parent', 'adult', 'guest');
CREATE TABLE public.family_members (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'adult',
  is_active boolean NOT NULL DEFAULT true
);
CREATE FUNCTION public.is_family_member(p_family_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.family_members WHERE family_id = p_family_id AND user_id = auth.uid() AND is_active
  )
$$;
CREATE FUNCTION public.family_role(p_family_id uuid) RETURNS public.member_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT role FROM public.family_members WHERE family_id = p_family_id AND user_id = auth.uid()
  ORDER BY case role when 'parent' then 0 when 'adult' then 1 else 2 end LIMIT 1
$$;

CREATE TYPE public.meal_type AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');
CREATE TABLE public.meals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name text NOT NULL,
  meal_type public.meal_type NOT NULL DEFAULT 'dinner',
  recipe_url text,
  image_url text,
  ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.family_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name text NOT NULL,
  ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url text,
  photo_url text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE TABLE public.meal_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  meal_id uuid REFERENCES public.meals(id) ON DELETE SET NULL,
  plan_date date NOT NULL,
  meal_type public.meal_type NOT NULL DEFAULT 'dinner',
  idempotency_key text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.grocery_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Groceries'
);
CREATE TABLE public.grocery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  list_id uuid NOT NULL REFERENCES public.grocery_lists(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_meal_id uuid REFERENCES public.meals(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grocery_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY meals_member ON public.meals FOR ALL
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
CREATE POLICY meal_plans_member ON public.meal_plans FOR ALL
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
CREATE POLICY grocery_lists_member ON public.grocery_lists FOR ALL
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
CREATE POLICY grocery_items_member ON public.grocery_items FOR ALL
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_members_member ON public.family_members FOR SELECT
  USING (public.is_family_member(family_id));

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_family_member(uuid), public.family_role(uuid) TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meals, public.meal_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grocery_lists, public.grocery_items TO authenticated;
GRANT SELECT ON public.family_members TO authenticated;

INSERT INTO public.families VALUES
  ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002');
INSERT INTO auth.users VALUES
  ('20000000-0000-0000-0000-000000000001'), ('20000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000003');
INSERT INTO public.family_members VALUES
  ('31000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'adult', true),
  ('31000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'adult', true),
  ('31000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'parent', false),
  ('31000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'guest', true);
INSERT INTO public.meals(id, family_id, name) VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Family A meal'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Family B secret');
INSERT INTO public.family_recipes(id, family_id, name, ingredients, source_url, photo_url, created_by) VALUES
  ('32000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Family A recipe', '[{"name":"beans","quantity":"2 cups","unit":null}]', 'https://recipes.example/a', null, '20000000-0000-0000-0000-000000000001'),
  ('32000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Family B secret recipe', '[]', null, null, '20000000-0000-0000-0000-000000000002');
-- Legacy duplicates are intentional: 0475 must preserve them until explicitly replaced.
INSERT INTO public.meal_plans(id, family_id, meal_id, plan_date, meal_type, created_by) VALUES
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '2026-10-04', 'dinner', '20000000-0000-0000-0000-000000000001'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '2026-10-04', 'dinner', '20000000-0000-0000-0000-000000000001');
