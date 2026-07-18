import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, BookOpen, Calendar, Clock, Mail, Tag } from 'lucide-react';
import { getAllPosts, getFeaturedPost, getPostsByCategory, getCategoryCounts, ALL_CATEGORIES, type BlogCategory, type BlogPost } from '@/lib/blog/posts';
import { articleHashtags, toHashtag } from '@/lib/blog/engagement';
import { BlogListStructuredData } from '@/components/marketing/structured-data';
import { Container, GradientText, PageWrap } from '@/components/marketing/visual-mocks';
import { SubscribeForm } from '@/components/blog/subscribe-form';
import { BlogHeroArt } from '@/components/blog/blog-hero-art';
import { cn } from '@/lib/utils/cn';
import { BlogSearch } from './blog-search';

export const metadata: Metadata = {
  title: 'Blog — Tips, Stories & Insights for Modern Families',
  description: 'Practical advice, real stories, and smart tips to help your family stay organized and enjoy more time together.',
  keywords: [
    'family organization', 'parenting tips', 'family life', 'meal planning', 'family finances',
    'kids activities', 'family wellness', 'family travel', 'home organization', 'bubaly',
  ],
  alternates: { canonical: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com'}/blog` },
  openGraph: {
    type: 'website',
    title: 'The Bubaly Blog — Tips, Stories & Insights for Modern Families',
    description: 'Practical advice, real stories, and smart tips to help your family stay organized and enjoy more time together.',
  },
};

export const revalidate = 3600;

const CATEGORY_COLORS: Record<BlogCategory, string> = {
  'Parenting': 'border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-400/20 dark:bg-violet-500/15 dark:text-violet-300',
  'Organization': 'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-400/20 dark:bg-blue-500/15 dark:text-blue-300',
  'School & Activities': 'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-500/15 dark:text-emerald-300',
  'AI & Technology': 'border-indigo-200 bg-indigo-100 text-indigo-800 dark:border-indigo-400/20 dark:bg-indigo-500/15 dark:text-indigo-300',
  'Wellness': 'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/15 dark:text-amber-300',
  'Family Finances': 'border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-400/20 dark:bg-rose-500/15 dark:text-rose-300',
  'Recipes & Food': 'border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-400/20 dark:bg-orange-500/15 dark:text-orange-300',
  'Travel & Adventures': 'border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-400/20 dark:bg-cyan-500/15 dark:text-cyan-300',
  'Home & Seasonal': 'border-teal-200 bg-teal-100 text-teal-800 dark:border-teal-400/20 dark:bg-teal-500/15 dark:text-teal-300',
};

const ACCENT_BG: Record<BlogCategory, string> = {
  'Parenting': 'from-violet-600/30 to-violet-900/10',
  'Organization': 'from-blue-600/30 to-blue-900/10',
  'School & Activities': 'from-emerald-600/30 to-emerald-900/10',
  'AI & Technology': 'from-indigo-600/30 to-indigo-900/10',
  'Wellness': 'from-amber-600/30 to-amber-900/10',
  'Family Finances': 'from-rose-600/30 to-rose-900/10',
  'Recipes & Food': 'from-orange-600/30 to-orange-900/10',
  'Travel & Adventures': 'from-cyan-600/30 to-cyan-900/10',
  'Home & Seasonal': 'from-teal-600/30 to-teal-900/10',
};

const CATEGORY_ICON_COLORS: Record<BlogCategory, string> = {
  'Parenting': 'bg-violet-500/20',
  'Organization': 'bg-blue-500/20',
  'School & Activities': 'bg-emerald-500/20',
  'AI & Technology': 'bg-indigo-500/20',
  'Wellness': 'bg-amber-500/20',
  'Family Finances': 'bg-rose-500/20',
  'Recipes & Food': 'bg-orange-500/20',
  'Travel & Adventures': 'bg-cyan-500/20',
  'Home & Seasonal': 'bg-teal-500/20',
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Hero photo with a graceful gradient fallback for image-less posts. */
function PostImage({ post, sizes, className, priority }: { post: BlogPost; sizes: string; className?: string; priority?: boolean }) {
  if (!post.heroImageUrl) {
    return <div className={cn('bg-gradient-to-br', ACCENT_BG[post.category] ?? 'from-white/5 to-white/[0.02]', className)} />;
  }
  return (
    <div className={cn('relative overflow-hidden', className)}>
      <Image
        src={post.heroImageUrl}
        alt={post.heroImageAlt ?? post.title}
        fill
        sizes={sizes}
        priority={priority}
        className="object-cover transition duration-500 group-hover:scale-[1.04]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
    </div>
  );
}

type Props = { searchParams: Promise<{ category?: string; unsubscribed?: string; tag?: string }> };

export default async function BlogPage({ searchParams }: Props) {
  const params = await searchParams;
  const activeCategory = ALL_CATEGORIES.find((c) => c === params.category) ?? null;
  const activeTag = params.tag ? toHashtag(params.tag) : null;
  const unsubscribed = params.unsubscribed === '1' ? 'done' : params.unsubscribed === 'invalid' ? 'invalid' : null;

  const [allPostsRaw, featured, categoryCounts] = await Promise.all([
    activeCategory ? getPostsByCategory(activeCategory) : getAllPosts(),
    activeCategory || activeTag ? Promise.resolve(undefined) : getFeaturedPost(),
    // Always fetch per-category counts (independent of the active filter) so
    // EVERY tab shows an accurate count, even when a category/tag is selected.
    getCategoryCounts(),
  ]);
  const totalCount = Object.values(categoryCounts).reduce((a, b) => a + b, 0);

  // Optional hashtag filter (from the Popular Tags cloud): match against each
  // post's normalized hashtag set so legacy + new posts both filter correctly.
  const allPosts = activeTag
    ? allPostsRaw.filter((p) => articleHashtags(p.tags, 12).includes(activeTag))
    : allPostsRaw;

  const postsForGrid = activeCategory || activeTag
    ? allPosts
    : allPosts.filter((p) => !p.featured);

  const recentPosts = allPosts.slice(0, 5);

  return (
    <PageWrap>
      <BlogListStructuredData posts={allPosts.map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt, date: p.date }))} />

      {/* Unsubscribe confirmation (arrives via /api/blog/unsubscribe redirect) */}
      {unsubscribed && (
        <Container className="pt-6">
          <div className={cn(
            'rounded-xl border px-4 py-3 text-sm font-semibold',
            unsubscribed === 'done'
              ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-400/25 bg-amber-500/10 text-amber-300',
          )} role="status">
            {unsubscribed === 'done'
              ? 'You’ve been unsubscribed from blog updates. Sorry to see you go — you can rejoin anytime below.'
              : 'That unsubscribe link doesn’t look right. If you keep getting emails, contact support and we’ll sort it out.'}
          </div>
        </Container>
      )}

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
            <BlogHeroArt className="h-auto w-full max-w-[440px]" />
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
            <span className="ml-1.5 text-xs text-white/30">({totalCount})</span>
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
              {/* Always show an accurate count on every tab. */}
              <span className="ml-1.5 text-xs text-white/30">({categoryCounts[cat] ?? 0})</span>
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
                  <div className="relative h-56 sm:h-72">
                    <PostImage post={featured} sizes="(min-width: 1024px) 640px, 100vw" className="absolute inset-0" priority />
                    <div className="absolute bottom-4 left-4 inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/30 px-3 py-1 text-xs font-bold uppercase tracking-wider text-violet-100 backdrop-blur">
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
              {activeCategory ? `${activeCategory} Articles` : activeTag ? `Articles tagged ${activeTag}` : 'Latest Articles'}
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
                    <PostImage post={post} sizes="(min-width: 1024px) 300px, (min-width: 640px) 50vw, 100vw" className="h-36" />
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
          </div>

          {/* Sidebar */}
          <aside className="space-y-6">
            {/* Recent posts (dynamic from DB) */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 font-bold">Recent Posts</h3>
              <ul className="space-y-4">
                {recentPosts.map((post) => (
                  <li key={post.slug}>
                    <Link href={`/blog/${post.slug}`} className="group flex gap-3">
                      <PostImage post={post} sizes="48px" className="h-12 w-12 shrink-0 rounded-lg" />
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
              <SubscribeForm source="blog-sidebar" variant="card" />
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
                      <span className="text-xs text-white/30">{categoryCounts[cat] ?? 0}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Tags from all posts */}
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
              <h3 className="mb-4 font-bold">Popular Tags</h3>
              <div className="flex flex-wrap gap-2">
                {Array.from(new Set(allPosts.flatMap((p) => articleHashtags(p.tags, 6)))).slice(0, 14).map((tag) => (
                  <Link
                    key={tag}
                    href={`/blog?tag=${encodeURIComponent(tag.replace(/^#/, ''))}`}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/60 transition hover:border-violet-400/30 hover:text-violet-200"
                  >
                    {tag}
                  </Link>
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
            <SubscribeForm source="blog-footer" variant="inline" />
          </div>
        </Container>
      </div>
    </PageWrap>
  );
}
