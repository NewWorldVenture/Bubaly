-- ============================================================
-- Migration 0010: Blog posts (CMS content moved into Supabase)
-- Replaces the hardcoded lib/blog/posts.ts dataset with a real
-- table. Public marketing /blog routes read published posts via
-- RLS (anon + authenticated SELECT where published = true).
-- Writes are service-role only (no write policy → RLS denies).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  excerpt         text NOT NULL DEFAULT '',
  author          text NOT NULL DEFAULT 'The Bubaly Team',
  published_at    date NOT NULL DEFAULT current_date,
  reading_minutes integer NOT NULL DEFAULT 5,
  tags            text[] NOT NULL DEFAULT '{}',
  category        text NOT NULL,
  featured        boolean NOT NULL DEFAULT false,
  accent_color    text,
  body            jsonb NOT NULL DEFAULT '[]'::jsonb,
  published       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON public.blog_posts (published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts (category);

-- keep updated_at fresh (reuses the shared trigger fn from 0003)
DROP TRIGGER IF EXISTS trg_blog_posts_updated_at ON public.blog_posts;
CREATE TRIGGER trg_blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: published posts are world-readable; writes are service-role only ──
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read published blog posts" ON public.blog_posts;
CREATE POLICY "Anyone can read published blog posts" ON public.blog_posts
  FOR SELECT TO anon, authenticated
  USING (published = true);

GRANT SELECT ON public.blog_posts TO anon, authenticated;

-- ── Seed the existing 11 posts (idempotent on slug) ──
INSERT INTO public.blog_posts (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color, body)
VALUES
  (
    'an-ai-chief-of-staff-for-your-home',
    'The AI Family Assistant: A New Way to Stay Ahead of Everything',
    'From school emails to soccer practice, see how AI can help your family stay organized, stress-free, and always one step ahead.',
    'Jessica Miller', '2024-05-12', 6, ARRAY['ai','product'], 'AI & Technology', true, '#7c5dff',
    $json$[
      {"type":"p","text":"Chatbots answer questions. A chief of staff gets things done. That distinction is the whole idea behind the Bubaly assistant."},
      {"type":"h2","text":"From words to records"},
      {"type":"p","text":"Ask it to add soccer every Tuesday and it creates the recurring event. Ask it to plan dinners and build a grocery list, and it writes real rows into your family's database."}
    ]$json$::jsonb
  ),
  (
    'sync-family-schedule',
    'How to Sync Your Family''s Schedule (Without the Chaos)',
    'A practical guide to keeping everyone on the same page — from soccer practice to dentist appointments.',
    'The Bubaly Team', '2024-05-10', 5, ARRAY['organization'], 'Organization', false, '#3b82f6',
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination. Here's how to make it visible and shared."}]$json$::jsonb
  ),
  (
    'last-day-school-checklist',
    'Last-Day-of-School Checklist: Don''t Miss a Thing',
    'Return the library books, pick up art projects, say goodbye to teachers — a complete end-of-year checklist.',
    'The Bubaly Team', '2024-05-09', 4, ARRAY['school'], 'School & Activities', false, '#10b981',
    $json$[{"type":"p","text":"The last week of school is a whirlwind. Here's how to get through it without forgetting anything."}]$json$::jsonb
  ),
  (
    'healthy-family-habits',
    'Healthy Family Habits That Stick (Even on Busy Weeks)',
    'Small rituals that make a big difference — and how to actually maintain them when life gets hectic.',
    'The Bubaly Team', '2024-05-07', 6, ARRAY['wellness'], 'Wellness', false, '#f59e0b',
    $json$[{"type":"p","text":"The habits that stick are the ones that require the least willpower."}]$json$::jsonb
  ),
  (
    'family-budget-basics',
    'Budgeting as a Family: 5 Simple Steps to Get Started',
    'Money conversations don''t have to be stressful. Here''s a framework that actually works for busy families.',
    'The Bubaly Team', '2024-05-04', 5, ARRAY['finances'], 'Family Finances', false, '#ec4899',
    $json$[{"type":"p","text":"Starting a family budget feels overwhelming. Break it into five simple steps."}]$json$::jsonb
  ),
  (
    'ai-family-life',
    '5 Ways AI Can Make Family Life So Much Easier',
    'From meal planning to homework help, AI is quietly transforming how modern families operate.',
    'The Bubaly Team', '2024-05-02', 6, ARRAY['ai'], 'AI & Technology', false, '#7c5dff',
    $json$[{"type":"p","text":"AI isn't just for tech companies. Here are five practical ways it's changing family life."}]$json$::jsonb
  ),
  (
    'quality-time',
    'How to Create More Quality Time (Without More Time)',
    'The secret isn''t finding more hours. It''s making the hours you have count.',
    'The Bubaly Team', '2024-04-30', 6, ARRAY['parenting','wellness'], 'Parenting', false, '#f97316',
    $json$[{"type":"p","text":"Most parents already know how precious time with their kids is. The challenge is protecting it."}]$json$::jsonb
  ),
  (
    'taming-the-family-mental-load',
    'Taming the family mental load',
    'The invisible work of running a household is real. Here''s how to share it.',
    'The Bubaly Team', '2026-05-02', 4, ARRAY['organization','parenting'], 'Parenting', false, NULL,
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination."}]$json$::jsonb
  ),
  (
    'meal-planning-that-actually-sticks',
    'Meal planning that actually sticks',
    'A simple weekly rhythm — and how to make the grocery list build itself.',
    'The Bubaly Team', '2026-05-18', 3, ARRAY['meals','routines'], 'Organization', false, NULL,
    $json$[{"type":"p","text":"Most meal-planning systems fail because they're too much work."}]$json$::jsonb
  )
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Done! Blog content now lives in Supabase. The /blog routes read
-- from public.blog_posts; lib/blog/posts.ts is now a data-access layer.
-- ============================================================
