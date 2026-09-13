import type { MetadataRoute } from 'next';
import { getAllPosts } from '@/lib/blog/posts';
import { createServiceClient } from '@/lib/supabase/server';
import { readBenchmarksPublication } from '@/lib/network/benchmarks-server';
import { staticRevision } from '@/lib/marketing/content-revisions';
import { canonicalUrl, isRegistryRenderedPath } from '@/lib/marketing/sitemap-urls';

/**
 * How long the sitemap will wait on the database before giving up on the
 * admin-published pages and shipping the routes it already knows.
 *
 * This route is PRERENDERED, so these reads run during `next build`. The
 * try/catch below handles a query that *errors*, but nothing bounded how long
 * one could *hang* — and an unreachable Postgres does not error promptly, it
 * sits at the TCP layer. That makes every deployment, on every branch, depend
 * on database health at build time: a sick database stops being an incident on
 * the site and becomes an incident on the deploy pipeline as well.
 *
 * A sitemap missing its admin-published landing pages for one deploy is a
 * small, self-correcting loss. A deployment that cannot ship during an
 * incident is not.
 */
const DB_BUDGET_MS = 5_000;

/** Resolves to `fallback` if `work` has not finished within the budget. */
async function withBudget<T>(work: PromiseLike<T>, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[sitemap] ${label} exceeded ${DB_BUDGET_MS}ms — shipping without it`);
      resolve(fallback);
    }, DB_BUDGET_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Static public routes. Legal pages are included so they're crawlable and
// discoverable (required for a production site). Authenticated app surfaces
// stay out of the sitemap and are disallowed in robots.ts.
const STATIC_ROUTES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
  { path: '', priority: 1, changeFrequency: 'weekly' },
  { path: '/features', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/how-it-works', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/pricing', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/ai', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/mobile', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/family-display', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/security', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/faq', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/blog', priority: 0.7, changeFrequency: 'weekly' },
  { path: '/contact', priority: 0.5, changeFrequency: 'yearly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/cookies', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/acceptable-use', priority: 0.3, changeFrequency: 'yearly' },
];

/**
 * The public URLs of this site, each dated by when its CONTENT last changed.
 *
 * Both halves of that sentence used to be wrong in production.
 *
 * The dates: every static entry was stamped with `new Date()`, so regenerating
 * the sitemap announced that ~1,500 URLs had all changed simultaneously. A
 * crawler that learns a site's lastmod is noise stops using it, costing the
 * signal on the pages that genuinely did change. Each source now answers from
 * its own real date, and anything with no real date to give omits
 * `lastModified` rather than inventing one.
 *
 * The URLs: 991 of the 1,508 listed should not have been there — 435 answered
 * 404 with `noindex` (registry rows for blog slugs the public site hides), 9
 * canonicalised to /blog, and the homepage was listed twice. Every source now
 * goes through canonicalUrl(), which is the only thing that may mint a `<loc>`.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: canonicalUrl(r.path)!,
    // Repository-authored copy: a constant that moves when the copy moves.
    lastModified: staticRevision(r.path),
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // Published blog posts (best-effort — getAllPosts degrades to [] on any error,
  // so a DB hiccup can never break the sitemap or the build).
  //
  // `updated_at` first: a post edited after publication changed on the edit
  // date, not the publish date. `published_at` is the fallback, and a row with
  // neither contributes no lastmod at all.
  const posts = await getAllPosts();
  const postEntries: MetadataRoute.Sitemap = posts.flatMap((p) => {
    const url = canonicalUrl(`/blog/${p.slug}`);
    if (!url) return [];
    return [{
      url,
      lastModified: p.updatedAt ? new Date(p.updatedAt) : p.date ? new Date(p.date) : undefined,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    }];
  });

  // NOTE: the /blog?category=… tabs are deliberately NOT listed.
  //
  // They are the /blog page with a query parameter, and that page declares
  // `alternates.canonical` pointing at /blog itself — so every one of them told
  // a crawler "index me" while the page it served said "index /blog instead".
  // A sitemap listing URLs that canonicalise elsewhere spends crawl budget to
  // be contradicted. The categories stay reachable and crawlable through the
  // links on /blog, which is how a canonicalised variant is supposed to be
  // found.

  // Landing pages are published from Super Admin and use a service-role read
  // because their table is intentionally private to the admin control plane.
  // A failed admin read must not take down the public sitemap.
  let landingEntries: MetadataRoute.Sitemap = [];
  let platformEntries: MetadataRoute.Sitemap = [];
  const benchmarkEntries: MetadataRoute.Sitemap = [];
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createServiceClient();
      const { data, error } = await withBudget(
        supabase
          .from('marketing_landing_pages')
          .select('slug, updated_at')
          .eq('published', true)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .then((r) => ({ data: r.data, error: r.error as unknown })),
        { data: null as { slug: string; updated_at: string }[] | null, error: null as unknown },
        'landing-page read',
      );

      if (error) {
        console.error('[sitemap] published landing-page read failed', error);
      } else {
        landingEntries = (data ?? []).flatMap((page) => {
          if (typeof page.slug !== 'string' || !page.slug) return [];
          const url = canonicalUrl(`/lp/${page.slug}`);
          if (!url) return [];
          return [{
            url,
            lastModified: page.updated_at ? new Date(page.updated_at) : undefined,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
          }];
        });
      }

      // The public household benchmarks page exists only while its admin
      // publication flag is on (it answers 404 otherwise), so it is listed
      // only then — a sitemap must never point at a 404.
      const benchmarks = await withBudget(
        readBenchmarksPublication(supabase),
        { ok: false } as Awaited<ReturnType<typeof readBenchmarksPublication>>,
        'benchmarks publication read',
      );
      if (benchmarks.ok && benchmarks.published) {
        benchmarkEntries.push({
          url: canonicalUrl('/resources/benchmarks')!,
          lastModified: benchmarks.updatedAt ? new Date(benchmarks.updatedAt) : undefined,
          changeFrequency: 'weekly' as const,
          priority: 0.6,
        });
      }

      const { data: platformPages, error: platformError } = await withBudget(
        supabase
          .from('marketing_pages')
          .select('path, updated_at, published_at')
          .eq('status', 'published')
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .then((r) => ({ data: r.data, error: r.error as unknown })),
        { data: null as { path: string; updated_at: string; published_at: string | null }[] | null, error: null as unknown },
        'platform-page read',
      );
      if (platformError) {
        console.error('[sitemap] published platform-page read failed', platformError);
      } else {
        // A registry row is an overlay on a path, not proof the path resolves:
        // only the prefixes the registry itself renders may add a URL here. See
        // isRegistryRenderedPath — /blog/… is served from blog_posts, and 435
        // registry rows for slugs blog_posts hides were publishing 404s.
        platformEntries = (platformPages ?? []).flatMap((page) => {
          if (typeof page.path !== 'string' || !isRegistryRenderedPath(page.path)) return [];
          const url = canonicalUrl(page.path);
          if (!url) return [];
          return [{
            url,
            lastModified: page.updated_at ? new Date(page.updated_at) : undefined,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
          }];
        });
      }
    } catch (error) {
      console.error('[sitemap] published landing-page read failed', error);
    }
  }

  const byUrl = new Map<string, MetadataRoute.Sitemap[number]>();
  for (const entry of [...staticEntries, ...postEntries, ...landingEntries, ...benchmarkEntries, ...platformEntries]) {
    const previous = byUrl.get(entry.url);
    if (!previous) {
      byUrl.set(entry.url, entry);
      continue;
    }
    const previousDate = previous.lastModified ? new Date(previous.lastModified).getTime() : 0;
    const nextDate = entry.lastModified ? new Date(entry.lastModified).getTime() : 0;
    byUrl.set(entry.url, {
      ...previous,
      ...entry,
      priority: Math.max(previous.priority ?? 0, entry.priority ?? 0),
      lastModified: Math.max(previousDate, nextDate) ? new Date(Math.max(previousDate, nextDate)) : undefined,
    });
  }
  return [...byUrl.values()];
}
