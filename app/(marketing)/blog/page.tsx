import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen, Calendar, Clock, Mail, Search, Tag } from 'lucide-react';
import { getAllPosts, getFeaturedPost, getPostsByCategory, ALL_CATEGORIES, type BlogCategory } from '@/lib/blog/posts';
import { Container, GradientText, PageWrap } from '@/components/marketing/visual-mocks';
import { cn } from '@/lib/utils/cn';
import { BlogSearch } from './blog-search';
import { SubscribeForm } from './subscribe-form';

export const metadata: Metadata = {
  title: 'Blog — Tips, Stories & Insights for Modern Families',
  description: 'Practical advice, real stories, and smart tips to help your family stay organized and enjoy more time together.',
  alternates: { types: { 'application/rss+xml': '/feed.xml' } },
};

export const revalidate = 3600;

const CATEGORY_COLORS: Record<BlogCategory, string> = {
  'Parenting': 'border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-400/20 dark:bg-violet-500/15 dark:text-violet-300',
  'Organization': 'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-400/20 dark:bg-blue-500/15 dark:text-blue-300',
  'School & Activities': 'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-500/15 dark:text-emerald-300',
  'AI & Technology': 'border-indigo-200 bg-indigo-100 text-indigo-800 dark:border-indigo-400/20 dark:bg-indigo-500/15 dark:text-indigo-300',
  'Wellness': 'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/15 dark:text-amber-300',
  'Family Finances': 'border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-400/20 dark:bg-rose-500/15 dark:text-rose-300',
};

const ACCENT_BG: Record<BlogCategory, string> = {
  'Parenting': 'from-violet-600/30 to-violet-900/10',
  'Organization': 'from-blue-600/30 to-blue-900/10',
  'School & Activities': 'from-emerald-600/30 to-emerald-900/10',
  'AI & Technology': 'from-indigo-600/30 to-indigo-900/10',
  'Wellness': 'from-amber-600/30 to-amber-900/10',
  'Family Finances': 'from-rose-600/30 to-rose-900/10',
};

const CATEGORY_ICON_COLORS: Record<BlogCategory, string> = {
  'Parenting': 'bg-violet-500/20',
  'Organization': 'bg-blue-500/20',
  'School & Activities': 'bg-emerald-500/20',
  'AI & Technology': 'bg-indigo-500/20',
  'Wellness': 'bg-amber-500/20',
  'Family Finances': 'bg-rose-500/20',
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type Props = { searchParams: Promise<{ category?: string }> };

export default async function BlogPage({ searchParams }: Props) {
  const params = await searchParams;
  const activeCategory = ALL_CATEGORIES.find((c) => c === params.category) ?? null;

  const [allPosts, featured] = await Promise.all([
    activeCategory ? getPostsByCategory(activeCategory) : getAllPosts(),
    activeCategory ? Promise.resolve(undefined) : getFeaturedPost(),
  ]);

  const postsForGrid = activeCategory
    ? allPosts
    : allPosts.filter((p) => !p.featured).slice(0, 9);

  const recentPosts = (activeCategory ? allPosts : allPosts).slice(0, 5);

  const categoryCounts = new Map<string, number>();
  if (!activeCategory) {
    for (const p of allPosts) {
      categoryCounts.set(p.category, (categoryCounts.get(p.category) ?? 0) + 1);
    }
  }

  return (
    <PageWrap>
      {/* Hero */}
      <Container className="pb-0 pt-16 lg:pt-20">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-300">The Family Life, Simplified.</p>
            <h1 className="text-5xl font-black leading-[1.06] sm:text-6xl">
              Tips, stories &amp; insights<br />
              <GradientText>for modern families.</GradientText>
            </h1>
            <p className="mt-5 text-lg leading-8 text-white/60">
              Practical advice, real stories, and smart tips to help you stay organized and enjoy more time together.
            </p>
            <BlogSearch posts={allPosts.map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt, category: p.category }))} />
          </div>
          <div className="hidden lg:flex lg:justify-end">
            <div className="relative h-64 w-80">
              <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-violet-600/20 to-blue-900/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="grid grid-cols-3 gap-4 p-8">
                  {['📅', '✅', '❤️', '🤖', '🛒', '📚'].map((emoji, i) => (
                    <div key={i} className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.06] text-2xl">
                      {emoji}
                    </div>
                  ))}
                </div>
              </div>
              <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
                <div className="h-24 w-24 rounded-full bg-violet-600/30 blur-2xl" />
              </div>
            </div>
          </div>
        </div>

        {/* Category tabs */}
        <div className="mt-10 flex flex-wrap gap-2 border-b border-white/8 pb-0">
          <Link
            href="/blog"
            className={cn(
              'rounded-t-xl px-4 py-2.5 text-sm font-medium transition',
              !activeCategory
                ? 'border border-b-0 border-white/15 bg-white/[0.06] font-semibold text-white'
                : 'text-white/55 hover:text-white',
            )}
          >
            All Articles
          </Link>
          {ALL_CATEGORIES.map((cat) => (
            <Link
              key={cat}
              href={`/blog?category=${encodeURIComponent(cat)}`}
              className={cn(
                'rounded-t-xl px-4 py-2.5 text-sm font-medium transition',
                activeCategory === cat
                  ? 'border border-b-0 border-white/15 bg-white/[0.06] font-semibold text-white'
                  : 'text-white/55 hover:text-white',
              )}
            >
              {cat}
              {!activeCategory && categoryCounts.has(cat) && (
                <span className="ml-1.5 text-xs text-white/30">({categoryCounts.get(cat)})</span>
              )}
            </Link>
          ))}
        </div>
      </Container>

      <Container className="py-10">
        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          {/* Main content */}
          <div>
            {/* Active category header */}
            {activeCategory && (
              <div className="mb-8 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn('grid h-10 w-10 place-items-center rounded-xl', CATEGORY_ICON_COLORS[activeCategory])}>
                    <Tag className="h-5 w-5 text-white/70" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold">{activeCategory}</h2>
                    <p className="text-xs text-white/50">{allPosts.length} article{allPosts.length !== 1 ? 's' : ''}</p>
                  </div>
                </div>
                <Link href="/blog" className="text-sm font-semibold text-violet-300 hover:text-violet-200">
                  View all &rarr;
                </Link>
              </div>
            )}

            {/* Featured */}
            {featured && !activeCategory && (
              <div className="mb-10">
                <h2 className="mb-5 text-lg font-bold">Featured</h2>
                <Link href={`/blog/${featured.slug}`} className="group block overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03] transition hover:border-violet-400/30">
                  <div className={cn('flex h-48 items-end bg-gradient-to-br p-6', ACCENT_BG[featured.category] ?? 'from-violet-600/20 to-blue-900/10')}>
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-violet-800 dark:border-violet-400/30 dark:bg-violet-500/20 dark:text-violet-200">
                      Featured
                    </div>
                  </div>
                  <div className="p-6">
                    <div className={cn('mb-2 inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold', CATEGORY_COLORS[featured.category])}>
                      {featured.category}
                    </div>
                    <h3 className="mt-2 text-xl font-bold leading-snug transition group-hover:text-violet-200">
                      {featured.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-white/55">{featured.excerpt}</p>
                    <div className="mt-4 flex items-center gap-4 text-xs text-white/40">
                      <span className="flex items-center gap-1.5"><BookOpen className="h-3.5 w-3.5" />{featured.author}</span>
                      <span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" />{fmtDate(featured.date)}</span>
                      <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />{featured.readingMinutes} min read</span>
                    </div>
                  </div>
                </Link>
              </div>
            )}

            {/* Grid */}
            <h2 className="mb-5 text-lg font-bold">
              {activeCategory ? `${activeCategory} Articles` : 'Latest Articles'}
            </h2>
            {postsForGrid.length === 0 ? (
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-10 text-center">
                <p className="text-white/50">No articles found in this category yet.</p>
                <Link href="/blog" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-violet-300 hover:text-violet-200">
                  View all articles <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {postsForGrid.map((post) => (
                  <Link key={post.slug} href={`/blog/${post.slug}`}
                    className="group flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03] transition hover:border-violet-400/30 hover:-translate-y-0.5">
                    <div className={cn('h-32 bg-gradient-to-br', ACCENT_BG[post.category] ?? 'from-white/5 to-white/[0.02]')} />
                    <div className="flex flex-1 flex-col p-4">
                      <div className={cn('mb-2 inline-block self-start rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider', CATEGORY_COLORS[post.category])}>
                        {post.category}
                      </div>
                      <h3 className="mt-1 text-sm font-bold leading-snug transition group-hover:text-violet-200">
                        {post.title}
                      </h3>
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-white/45">{post.excerpt}</p>
                      <div className="mt-auto pt-3 flex items-center gap-2 text-[11px] text-white/40">
                        <span>{fmtDate(post.date)}</span>
                        <span>·</span>
                        <span>{post.readingMinutes} min read</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {!activeCategory && allPosts.length > 10 && (
              <div className="mt-8 text-center">
                <button className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/70 transition hover:border-violet-400/40 hover:text-white">
                  Load More Articles <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-6">
            {/* Recent posts (dynamic from DB) */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 font-bold">Recent Posts</h3>
              <ul className="space-y-4">
                {recentPosts.map((post, i) => (
                  <li key={post.slug}>
                    <Link href={`/blog/${post.slug}`} className="group flex gap-3">
                      <div className={cn('h-12 w-12 shrink-0 rounded-lg bg-gradient-to-br', ACCENT_BG[post.category] ?? 'from-violet-600/20 to-blue-900/10')} />
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-sm font-semibold leading-snug transition group-hover:text-violet-200">{post.title}</p>
                        <p className="mt-0.5 text-xs text-white/40">{fmtDate(post.date)}</p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Subscribe */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-1 font-bold">Subscribe to Our Blog</h3>
              <p className="mb-4 text-xs leading-5 text-white/55">Get the latest tips and insights delivered to your inbox.</p>
              <SubscribeForm className="space-y-3" buttonClass="w-full" />
            </div>

            {/* Topics with counts */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 font-bold">Browse Topics</h3>
              <ul className="space-y-2.5">
                {ALL_CATEGORIES.map((cat) => (
                  <li key={cat}>
                    <Link
                      href={`/blog?category=${encodeURIComponent(cat)}`}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition',
                        activeCategory === cat
                          ? 'bg-white/[0.06] font-semibold text-white'
                          : 'text-white/60 hover:bg-white/[0.03] hover:text-white',
                      )}
                    >
                      <div className={cn('h-2 w-2 rounded-full', CATEGORY_ICON_COLORS[cat])} />
                      <span className="flex-1">{cat}</span>
                      {categoryCounts.has(cat) && (
                        <span className="text-xs text-white/30">{categoryCounts.get(cat)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Tags from all posts */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 font-bold">Popular Tags</h3>
              <div className="flex flex-wrap gap-2">
                {Array.from(new Set(allPosts.flatMap((p) => p.tags))).slice(0, 12).map((tag) => (
                  <span key={tag} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/60">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </Container>

      {/* Newsletter CTA */}
      <div className="border-t border-white/8">
        <Container className="py-14">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-5">
              <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-violet-600/20">
                <Mail className="h-7 w-7 text-violet-300" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Stay in the Loop</h2>
                <p className="text-sm text-white/55">New tips, real stories, and helpful resources — straight to your inbox.</p>
              </div>
            </div>
            <SubscribeForm className="w-full max-w-md" inputClass="py-3" buttonClass="py-3" />
          </div>
        </Container>
      </div>
    </PageWrap>
  );
}
