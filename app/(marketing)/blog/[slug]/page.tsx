import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, Calendar, ChevronRight, Clock, Mail, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getAllPosts, getPost, getRelatedPosts, getAdjacentPosts, extractHeadings, type BlogCategory } from '@/lib/blog/posts';
import { articleHashtags } from '@/lib/blog/engagement';
import { BlogPostStructuredData, FaqStructuredData } from '@/components/marketing/structured-data';
import { readAeoQuestionsForCategory } from '@/lib/marketing/aeo';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';
import { HeartButton } from '@/components/blog/heart-button';
import { BlogCover } from '@/components/blog/blog-cover';
import { SubscribeForm } from '@/components/blog/subscribe-form';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { ReadingProgress } from './reading-progress';
import { ShareButtons } from './share-buttons';
import { TableOfContents } from './table-of-contents';

type Params = { params: Promise<{ slug: string }> };

export const revalidate = 3600;
export const dynamicParams = true;

const CATEGORY_COLORS: Record<BlogCategory, string> = {
  'Parenting': 'border-violet-400/20 bg-violet-500/15 text-violet-300',
  'Organization': 'border-blue-400/20 bg-blue-500/15 text-blue-300',
  'School & Activities': 'border-emerald-400/20 bg-emerald-500/15 text-emerald-300',
  'AI & Technology': 'border-indigo-400/20 bg-indigo-500/15 text-indigo-300',
  'Wellness': 'border-amber-400/20 bg-amber-500/15 text-amber-300',
  'Family Finances': 'border-rose-400/20 bg-rose-500/15 text-rose-300',
  'Recipes & Food': 'border-orange-400/20 bg-orange-500/15 text-orange-300',
  'Travel & Adventures': 'border-cyan-400/20 bg-cyan-500/15 text-cyan-300',
  'Home & Seasonal': 'border-teal-400/20 bg-teal-500/15 text-teal-300',
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

export async function generateStaticParams() {
  return (await getAllPosts()).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: 'Post not found' };
  const keywords = articleHashtags(post.tags, 10).map((h) => h.replace(/^#/, ''));
  const canonical = `${SITE_URL}/blog/${post.slug}`;
  // Closed loop: the SEO Page Registry (/admin/marketing/seo) can override this
  // article's title + description; the post-derived values are the fallback.
  return resolveMarketingMetadata(`/blog/${post.slug}`, {
    title: post.title,
    description: post.excerpt,
    keywords,
    authors: [{ name: post.author }],
    category: post.category,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      url: canonical,
      title: post.title,
      description: post.excerpt,
      authors: [post.author],
      publishedTime: post.date,
      modifiedTime: post.date,
      section: post.category,
      tags: keywords,
      ...(post.heroImageUrl
        ? { images: [{ url: post.heroImageUrl, alt: post.heroImageAlt ?? post.title }] }
        : {}),
    },
    twitter: {
      card: post.heroImageUrl ? 'summary_large_image' : 'summary',
      title: post.title,
      description: post.excerpt,
      ...(post.heroImageUrl ? { images: [post.heroImageUrl] } : {}),
    },
  });
}

export default async function BlogPostPage({ params }: Params) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const [related, { prev, next }, aeo] = await Promise.all([
    getRelatedPosts(slug, post.category, 3),
    getAdjacentPosts(post.date),
    // Category-relevant answers from the admin AEO Knowledge Center → an on-topic
    // FAQ block + FAQPage schema on every article, linking back to the source.
    readAeoQuestionsForCategory(post.category, 4),
  ]);
  const aeoFaqs = aeo.questions;

  const headings = extractHeadings(post.body);
  const wordCount = post.body.reduce((n, b) => n + b.text.split(/\s+/).length, 0);

  return (
    <>
      <BlogPostStructuredData
        slug={post.slug}
        title={post.title}
        excerpt={post.excerpt}
        author={post.author}
        category={post.category}
        date={post.date}
        heroImageUrl={post.heroImageUrl}
        keywords={articleHashtags(post.tags, 10).map((h) => h.replace(/^#/, ''))}
        wordCount={wordCount}
      />
      <ReadingProgress />

      <div className="mx-auto max-w-7xl px-4 pt-16 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-white/40">
          <Link href="/blog" className="transition hover:text-white/70">Blog</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <Link href={`/blog?category=${encodeURIComponent(post.category)}`} className="transition hover:text-white/70">
            {post.category}
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="truncate text-white/60">{post.title}</span>
        </nav>

        <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
          {/* Main article */}
          <article className="min-w-0">
            {/* Hero photo */}
            {post.heroImageUrl ? (
              <figure className="mb-8">
                <div className="relative h-56 overflow-hidden rounded-2xl sm:h-80">
                  <Image
                    src={post.heroImageUrl}
                    alt={post.heroImageAlt ?? post.title}
                    fill
                    priority
                    sizes="(min-width: 1024px) 800px, 100vw"
                    className="object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
                  <div className={cn('absolute bottom-4 left-4 inline-block rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur', CATEGORY_COLORS[post.category])}>
                    {post.category}
                  </div>
                </div>
                {post.heroImageCredit && (
                  <figcaption className="mt-2 text-right text-[11px] text-white/30">
                    Photo: {post.heroImageCredit}
                  </figcaption>
                )}
              </figure>
            ) : (
              <figure className="mb-8">
                <div className="relative flex h-48 items-end overflow-hidden rounded-2xl p-6 sm:h-80">
                  <BlogCover title={post.title} category={post.category} seed={post.slug} className="absolute inset-0 h-full w-full object-cover" />
                  <div className={cn('relative inline-block rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur', CATEGORY_COLORS[post.category])}>
                    {post.category}
                  </div>
                </div>
              </figure>
            )}

            {/* Title & meta */}
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl lg:text-5xl">{post.title}</h1>

            <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-white/50">
              <span className="flex items-center gap-1.5">
                <User className="h-4 w-4" /> {post.author}
              </span>
              <span className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4" /> {fmtDate(post.date, 'MMMM d, yyyy')}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" /> {post.readingMinutes} min read
              </span>
              <HeartButton slug={post.slug} />
            </div>

            {/* Hashtags (social-ready; always includes #bubaly) */}
            <div className="mt-4 flex flex-wrap gap-2">
              {articleHashtags(post.tags).map((t) => (
                <Badge key={t} tone="brand">{t}</Badge>
              ))}
            </div>

            {/* Share */}
            <div className="mt-6 flex items-center gap-3 border-b border-white/8 pb-6">
              <span className="text-xs font-semibold text-white/40">SHARE</span>
              <ShareButtons title={post.title} slug={post.slug} />
            </div>

            {/* Article body */}
            <div className="prose-family mt-8 space-y-5 pb-10">
              {post.body.map((block, i) =>
                block.type === 'h2' ? (
                  <h2
                    key={i}
                    id={block.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}
                    className="scroll-mt-24 text-xl font-bold sm:text-2xl"
                  >
                    {block.text}
                  </h2>
                ) : (
                  <p key={i} className="text-base leading-7 text-white/70">{block.text}</p>
                ),
              )}
            </div>

            {/* AEO FAQ — answers from the Knowledge Center, on-topic for this
                article, feeding FAQPage rich results and voice/AI answers. */}
            {aeoFaqs.length > 0 && (
              <section className="mb-10 rounded-2xl border border-white/8 bg-white/[0.02] p-6" aria-labelledby="article-faq">
                <FaqStructuredData items={aeoFaqs.map((q) => ({ q: q.question, a: q.answer }))} />
                <h2 id="article-faq" className="scroll-mt-24 text-xl font-bold sm:text-2xl">Frequently asked questions</h2>
                <dl className="mt-5 space-y-5">
                  {aeoFaqs.map((q) => (
                    <div key={q.question}>
                      <dt className="font-semibold text-white/90">{q.question}</dt>
                      <dd className="mt-1.5 text-sm leading-7 text-white/60">{q.answer}</dd>
                    </div>
                  ))}
                </dl>
                <Link href="/faq" className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-violet-300 hover:text-violet-200">
                  Explore the full Family Knowledge Center <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </section>
            )}

            {!aeo.available && (
              <p className="mb-10 rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200" role="status">
                The related Knowledge Center answers are temporarily unavailable. This article is complete; please refresh later for the latest FAQs.
              </p>
            )}

            {/* Did you enjoy it? ♥ + subscribe */}
            <div className="rounded-2xl border border-white/8 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-6">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <HeartButton slug={post.slug} />
                  <p className="text-sm text-white/60">Enjoyed this one? Sign in and save it to your account.</p>
                </div>
              </div>
              <div className="mt-5 border-t border-white/8 pt-5">
                <div className="mb-3 flex items-center gap-2">
                  <Mail className="h-4 w-4 text-violet-300" />
                  <p className="text-sm font-bold">Get the next article in your inbox</p>
                </div>
                <SubscribeForm source="article" variant="inline" />
              </div>
            </div>

            {/* Author bio */}
            <div className="mt-2 border-t border-white/8 py-8">
              <div className="flex items-start gap-4">
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-violet-600/20">
                  <User className="h-7 w-7 text-violet-300" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-white/40">Written by</p>
                  <p className="mt-1 text-lg font-bold">{post.author}</p>
                  <p className="mt-1 text-sm leading-6 text-white/50">
                    Part of the Bubaly team, helping families stay organized and connected through practical advice and real-world insights.
                  </p>
                </div>
              </div>
            </div>

            {/* Share bottom */}
            <div className="flex items-center gap-3 border-t border-white/8 py-6">
              <span className="text-xs font-semibold text-white/40">SHARE THIS ARTICLE</span>
              <ShareButtons title={post.title} slug={post.slug} />
            </div>

            {/* Prev / Next navigation */}
            {(prev || next) && (
              <div className="grid gap-4 border-t border-white/8 py-8 sm:grid-cols-2">
                {prev ? (
                  <Link href={`/blog/${prev.slug}`} className="group flex flex-col rounded-2xl border border-white/8 bg-white/[0.03] p-5 transition hover:border-violet-400/20">
                    <span className="mb-2 flex items-center gap-1 text-xs text-white/40">
                      <ArrowLeft className="h-3.5 w-3.5" /> Previous Article
                    </span>
                    <span className="text-sm font-bold transition group-hover:text-violet-200">{prev.title}</span>
                    <span className="mt-1 text-xs text-white/40">{fmtDate(prev.date)}</span>
                  </Link>
                ) : <div />}
                {next ? (
                  <Link href={`/blog/${next.slug}`} className="group flex flex-col items-end rounded-2xl border border-white/8 bg-white/[0.03] p-5 text-right transition hover:border-violet-400/20">
                    <span className="mb-2 flex items-center gap-1 text-xs text-white/40">
                      Next Article <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-sm font-bold transition group-hover:text-violet-200">{next.title}</span>
                    <span className="mt-1 text-xs text-white/40">{fmtDate(next.date)}</span>
                  </Link>
                ) : <div />}
              </div>
            )}
          </article>

          {/* Sidebar */}
          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-6">
              {/* Table of contents */}
              {headings.length > 0 && (
                <TableOfContents headings={headings} />
              )}

              {/* Related posts */}
              {related.length > 0 && (
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
                  <h3 className="mb-4 text-sm font-bold">Related Articles</h3>
                  <ul className="space-y-4">
                    {related.map((r) => (
                      <li key={r.slug}>
                        <Link href={`/blog/${r.slug}`} className="group flex gap-3">
                          {r.heroImageUrl ? (
                            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                              <Image src={r.heroImageUrl} alt={r.heroImageAlt ?? r.title} fill sizes="48px" className="object-cover" />
                            </div>
                          ) : (
                            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                              <BlogCover title={r.title} category={r.category} seed={r.slug} className="absolute inset-0 h-full w-full object-cover" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <span className="line-clamp-2 text-sm font-semibold leading-snug transition group-hover:text-violet-200">{r.title}</span>
                            <span className="mt-0.5 flex items-center gap-2 text-[11px] text-white/40">
                              <span>{fmtDate(r.date)}</span>
                              <span>·</span>
                              <span>{r.readingMinutes} min</span>
                            </span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Subscribe */}
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
                <h3 className="mb-1 text-sm font-bold">Never miss an article</h3>
                <p className="mb-3 text-xs leading-5 text-white/55">New tips and stories for modern families, straight to your inbox.</p>
                <SubscribeForm source="blog-sidebar" variant="card" />
              </div>

              {/* Back to blog */}
              <Link href="/blog" className="flex items-center gap-2 text-sm font-semibold text-violet-300 hover:text-violet-200">
                <ArrowLeft className="h-4 w-4" /> Back to all articles
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
