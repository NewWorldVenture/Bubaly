-- ── Every permissive policy names its caller ─────────────────────────────────
-- A-03 proves every family-scoped table has RLS on, and A-16
-- (blanket-policy-check.sql) forbids a policy that is literally `true`. Neither
-- sees the policy in between: `using (published_at is not null)`, or
-- `using (status = 'open')` on a table of family rows. That is RLS switched on
-- and permitting every signed-in person on the internet, and it is one typo
-- away from any `using (is_family_member(family_id) or …)`.
--
-- The rule here: every PERMISSIVE policy a client role can use (anon,
-- authenticated, or PUBLIC) must, in the expression that governs its command
-- (USING for SELECT/UPDATE/DELETE/ALL, WITH CHECK for INSERT), refer to the
-- caller — auth.uid(), auth.jwt(), auth.role(), or a call to a public function
-- whose own body reads auth.uid()/auth.jwt() (is_family_member,
-- can_manage_family, is_marketplace_circle_member, …). The helper list is
-- DERIVED from pg_proc, not typed here, so a new helper counts the day it lands
-- and a helper that stops reading the caller stops counting.
--
-- Deliberately public reads (published marketing pages, catalogues everyone
-- shares) are named below, each with its reason, and held to not being
-- family-scoped. Adding one is a decision somebody writes down here.
--
-- Added 2026-09-28 by the API/DB audit (finalaudit.md, "DB policy pass").
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/every-policy-names-its-caller-check.sql

create temporary table caller_free_allowlist (relname text, polname text, why text, primary key (relname, polname));
insert into caller_free_allowlist values
  ('app_settings',                        'app_settings_read_feature_tiers',          'only the feature_tiers key: the public plan catalogue the pricing page renders'),
  ('badges',                              'badges_read',                              'the badge catalogue, the same for every family'),
  ('blog_posts',                          'Anyone can read published blog posts',     'published blog posts are the public blog'),
  ('feature_flags',                       'Authenticated read feature_flags',         'flag names and states; no family column'),
  ('invest_assets',                       'Authenticated read invest_assets',         'the catalogue of assets a child can learn about; no family column'),
  ('marketing_aeo_question_translations', 'marketing_aeo_translation_public_read',    'translations of published public Q&A'),
  ('marketing_aeo_questions',             'marketing_aeo_public_read',                'published public Q&A'),
  ('marketing_page_relationships',        'marketing_page_relationships_public_read', 'links between published public pages'),
  ('marketing_pages',                     'marketing_pages_public_read',              'published public marketing pages'),
  ('marketing_seo_pages',                 'marketing_seo_pages_public_read',          'active public SEO pages'),
  ('meal_ideas',                          'meal_ideas_select',                        'the seeded recipe catalogue, shared by every household'),
  ('service_descriptions',                'Service descriptions are readable',        'public marketing copy served by /api/services/descriptions'),
  ('stripe_card_designs',                 'Authenticated read card designs',          'the card-design catalogue; no family column');

-- Public functions whose body reads the caller, directly or through another
-- such function (social_has_permission and is_marketplace_circle_member read
-- it through is_family_member). Calling one of these is naming the caller.
-- Iterated to a fixed point rather than recursed, because a function may name
-- several helpers and the set only grows.
create or replace function pg_temp.caller_helpers() returns text[] language plpgsql stable as $$
declare
  found text[];
  grown text[];
begin
  select coalesce(array_agg(distinct p.proname::text), '{}') into found
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ~* 'auth\.(uid|jwt)\(\)';
  loop
    select coalesce(array_agg(distinct p.proname::text), '{}') into grown
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname = any(found)
           or exists (select 1 from unnest(found) f
                      where p.prosrc ~* ('(^|[^a-z0-9_])' || f || '\s*\(')));
    exit when cardinality(grown) = cardinality(found);
    found := grown;
  end loop;
  return found;
end $$;

-- The rule, once: permissive, client-usable policies in `schema_name` whose
-- governing expression names no caller.
create or replace function pg_temp.caller_free_policies(schema_name text)
returns table (relname text, polname text, cmd text, expr text) language sql stable as $$
  with helpers as (select pg_temp.caller_helpers() h),
  pol as (
    select c.relname::text, p.polname::text,
      case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
      coalesce(case when p.polcmd = 'a' then pg_get_expr(p.polwithcheck, p.polrelid)
                    else pg_get_expr(p.polqual, p.polrelid) end, '') as expr,
      p.polroles
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = schema_name and p.polpermissive
  )
  select pol.relname, pol.polname, pol.cmd, pol.expr
  from pol, helpers
  where
    -- a client can use it: PUBLIC (oid 0), anon or authenticated
    exists (select 1 from unnest(pol.polroles) r
            where r = 0 or r in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
    -- USING (false) admits nobody (sync_tokens: service only), so it is not a leak
    and pol.expr !~* '^\(?false\)?$'
    and pol.expr !~* 'auth\.(uid|jwt|role)\(\)'
    and not exists (
      select 1 from unnest(helpers.h) f
      where pol.expr ~* ('(^|[^a-z0-9_])' || f || '\s*\('))
$$;

-- ── NEGATIVE CONTROL ─────────────────────────────────────────────────────────
-- The detector must see a leak, or its silence below means nothing. A table
-- with a family column and a policy that does not name the caller, created in
-- a transaction that is rolled back.
begin;
create table public.caller_free_probe_table (id int, family_id uuid, status text);
alter table public.caller_free_probe_table enable row level security;
create policy caller_free_probe_leak on public.caller_free_probe_table
  for select to authenticated using (status = 'open');
create policy caller_free_probe_tied on public.caller_free_probe_table
  for update to authenticated using (public.is_family_member(family_id));
do $$
declare found text[];
begin
  select array_agg(polname order by polname) into found
  from pg_temp.caller_free_policies('public') where relname = 'caller_free_probe_table';
  if found is distinct from array['caller_free_probe_leak'] then
    raise exception 'NEGATIVE CONTROL: the detector should flag exactly the leaky probe policy, found %', found;
  end if;
  raise notice 'negative control: a policy using (status = ''open'') is flagged, and one using is_family_member(family_id) is not';
end $$;
rollback;

-- ── INVARIANT 1: no policy lets a client in without naming who it is ─────────
do $$
declare bad text;
begin
  select string_agg(format('%s.%s (%s): %s', f.relname, f.polname, f.cmd, left(f.expr, 120)), E'\n  ')
    into bad
  from pg_temp.caller_free_policies('public') f
  where not exists (select 1 from caller_free_allowlist a where a.relname = f.relname and a.polname = f.polname);
  if bad is not null then
    raise exception E'Permissive policies that never name the caller (add the caller, or allowlist it here with a reason):\n  %', bad;
  end if;
end $$;

-- ── INVARIANT 2: the allowlist is not stale, and nothing on it is family data ─
do $$
declare stale text; family_scoped text;
begin
  select string_agg(a.relname || '.' || a.polname, ', ') into stale
  from caller_free_allowlist a
  where not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = a.relname and p.polname = a.polname);
  if stale is not null then
    raise exception 'Allowlisted policies that no longer exist (remove them): %', stale;
  end if;

  select string_agg(distinct a.relname, ', ') into family_scoped
  from caller_free_allowlist a
  join pg_class c on c.relname = a.relname
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute att on att.attrelid = c.oid and att.attname = 'family_id' and att.attnum > 0 and not att.attisdropped;
  if family_scoped is not null then
    raise exception 'An allowlisted caller-free policy sits on a family-scoped table: %', family_scoped;
  end if;
end $$;

do $$
declare n_pol int; n_help int;
begin
  select count(*) into n_pol from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and p.polpermissive;
  select cardinality(pg_temp.caller_helpers()) into n_help;
  if n_help < 3 then
    raise exception 'Only % caller helpers found; is_family_member and can_manage_family should be among them', n_help;
  end if;
  raise notice 'every-policy-names-its-caller: % permissive policies checked against % caller helpers; % allowlisted', n_pol, n_help,
    (select count(*) from caller_free_allowlist);
end $$;
