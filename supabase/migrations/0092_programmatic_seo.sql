-- 0092_programmatic_seo.sql
-- Programmatic SEO / AEO landing-page system.
-- Define ONE template for a topic, then generate many location/criteria pages
-- (e.g. "Family organizer in {state}") that are managed centrally: editing the
-- template re-renders every generated page, because pages store only their
-- resolved slug + variables and the content is derived from the template at
-- render time.

-- ── Templates ───────────────────────────────────────────────────────────────
create table if not exists seo_page_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  topic text,
  -- Slug pattern with {variables}, e.g. 'family-organizer/{state_slug}'.
  slug_pattern text not null,
  eyebrow text,
  h1_template text not null,
  subhead_template text,
  meta_title_template text,
  meta_description_template text,
  -- Intro body: paragraphs separated by blank lines, supports {variables}.
  intro_template text,
  -- [{ icon, title, description }] with {variables} in title/description.
  feature_blocks jsonb not null default '[]'::jsonb,
  -- [{ q, a }] with {variables} — rendered as an FAQ + JSON-LD FAQPage (AEO).
  faqs jsonb not null default '[]'::jsonb,
  cta_label text,
  cta_href text not null default '/signup',
  -- Static variables applied to every generated page, e.g. { "product": "Bubaly" }.
  static_vars jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Generated pages ─────────────────────────────────────────────────────────
create table if not exists seo_pages (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references seo_page_templates(id) on delete cascade,
  -- Resolved path without leading slash, e.g. 'family-organizer/california'.
  slug text not null unique,
  -- Resolved variables for this page, e.g. { "state": "California", "state_abbr": "CA", "state_slug": "california" }.
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  views integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_seo_pages_template on seo_pages(template_id);
create index if not exists idx_seo_pages_status on seo_pages(status);
create index if not exists idx_seo_pages_slug on seo_pages(slug);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists set_seo_page_templates_updated_at on seo_page_templates;
    create trigger set_seo_page_templates_updated_at before update on seo_page_templates
      for each row execute function set_updated_at();
    drop trigger if exists set_seo_pages_updated_at on seo_pages;
    create trigger set_seo_pages_updated_at before update on seo_pages
      for each row execute function set_updated_at();
  end if;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Content is admin-managed via the service-role client and read publicly via the
-- service-role client (same pattern as marketing_landing_pages). Writes are
-- service-role only; published pages / active templates are publicly readable so
-- the public route works even with the anon client.
alter table seo_page_templates enable row level security;
alter table seo_pages enable row level security;

drop policy if exists "public reads active seo templates" on seo_page_templates;
create policy "public reads active seo templates" on seo_page_templates
  for select using (is_active = true);

drop policy if exists "public reads published seo pages" on seo_pages;
create policy "public reads published seo pages" on seo_pages
  for select using (status = 'published');
