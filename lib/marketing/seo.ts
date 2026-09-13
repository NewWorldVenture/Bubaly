// lib/marketing/seo.ts — public reader that lets the admin SEO store
// (/admin/marketing/seo → marketing_seo_pages) drive the <title> and meta
// description of public routes. Active rows are world-readable (migration 0230).
// Every page passes a code fallback, so a missing/empty row never breaks SEO —
// the admin store simply overrides when present (the single source of truth).
import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { OG_SIZE, OG_CONTENT_TYPE, OG_ALT } from '@/lib/og/social-image';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function getSeoPage(path: string): Promise<{ title: string | null; description: string | null; canonical: string | null } | null> {
  try {
    // Optional editorial overrides must not hold a public navigation open
    // through the SDK's retry backoff. Both stores share one total budget.
    const signal = AbortSignal.timeout(1500);
    const client = anonClient();
    // The platform registry is canonical for newly managed page families. The
    // legacy SEO table remains a compatibility fallback for routes that have not
    // yet been migrated by Super Admin.
    const { data: platform } = await client
      .from('marketing_pages')
      .select('title, summary, seo, status')
      .eq('path', path)
      .eq('status', 'published')
      .is('deleted_at', null)
      .abortSignal(signal)
      .maybeSingle();
    if (platform) {
      const seo = platform.seo && typeof platform.seo === 'object' && !Array.isArray(platform.seo)
        ? platform.seo as { title?: unknown; description?: unknown; canonical?: unknown }
        : {};
      return {
        title: typeof seo.title === 'string' && seo.title.trim() ? seo.title : platform.title,
        description: typeof seo.description === 'string' && seo.description.trim() ? seo.description : platform.summary,
        canonical: typeof seo.canonical === 'string' && seo.canonical.trim() ? seo.canonical : null,
      };
    }
    signal.throwIfAborted();
    const { data } = await client
      .from('marketing_seo_pages')
      .select('title, meta_description, metadata, status')
      .eq('path', path)
      .eq('status', 'active')
      .abortSignal(signal)
      .maybeSingle();
    if (!data) return null;
    const metadata = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? data.metadata as { canonical?: unknown }
      : {};
    return {
      title: data.title,
      description: data.meta_description,
      canonical: typeof metadata.canonical === 'string' && metadata.canonical.trim() ? metadata.canonical : null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a route's Next Metadata from the admin SEO store, falling back to
 * developer-authored values. Use in a page's `generateMetadata()`.
 */
/**
 * The root layout sets `template: '%s · Bubaly'`, so every title it formats gets
 * the brand appended. A title that ALREADY ends in the brand is then doubled:
 * the admin SEO store held "Security & Privacy — Bubaly", and the live page
 * shipped `Security & Privacy — Bubaly · Bubaly`. Same for "Contact Bubaly".
 *
 * The store is admin-editable free text, so this cannot be fixed by correcting
 * the rows — the next person to type a brand-suffixed title reintroduces it.
 * The template owns the brand, so a title that supplies its own opts out of the
 * template via `absolute` instead of being appended to.
 *
 * Only a TRAILING brand counts. "Bubaly — The AI Family Operating System" leads
 * with the name and still wants the suffix; suppressing it there would drop the
 * brand from the end of the tab title, which is the opposite of the intent.
 */
export function titleWithoutDoubledBrand(title: string): Metadata['title'] {
  return /(?:^|[\s—–\-|·:])Bubaly\s*$/i.test(title.trim()) ? { absolute: title } : title;
}

export async function resolveMarketingMetadata(path: string, fallback: Metadata): Promise<Metadata> {
  const seo = await getSeoPage(path);
  const resolved = seo?.title ?? fallback.title ?? undefined;
  const title = typeof resolved === 'string' ? titleWithoutDoubledBrand(resolved) : resolved;
  const description = seo?.description ?? fallback.description ?? undefined;
  const canonical = seo?.canonical
    ? (seo.canonical.startsWith('http') ? seo.canonical : `${SITE_URL}${seo.canonical.startsWith('/') ? seo.canonical : `/${seo.canonical}`}`)
    : undefined;
  const priorOg = (fallback.openGraph ?? {}) as Record<string, unknown>;
  const priorAlternates = (fallback.alternates ?? {}) as Record<string, unknown>;
  return {
    ...fallback,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(canonical ? { alternates: { ...priorAlternates, canonical } } : {}),
    // A segment that declares `openGraph` REPLACES the root layout's resolved
    // object — Next does not deep-merge it, and it stops applying the
    // `app/opengraph-image.tsx` file convention for that route. Returning only
    // {title, description} therefore deleted og:image, og:url, og:type and
    // og:site_name from every marketing page while /login (which does not call
    // this) kept all four. Shared links to the homepage, pricing, features and
    // every blog post rendered with no preview image anywhere.
    //
    // So the site-wide defaults are restated here in full. They stay first so a
    // page's own fallback.openGraph still wins for anything it sets.
    openGraph: {
      type: 'website',
      siteName: 'Bubaly',
      images: [{
        url: `${SITE_URL}/opengraph-image`,
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        alt: OG_ALT,
        type: OG_CONTENT_TYPE,
      }],
      ...priorOg,
      // The plain string, never the `absolute` wrapper that the document title
      // may carry. openGraph has no brand template of its own, so og:title was
      // never doubled and needs no opt-out.
      ...(resolved ? { title: resolved } : {}),
      ...(description ? { description } : {}),
      // The canonical is the page's own URL, so it is also the right og:url.
      ...(canonical ? { url: canonical } : (priorOg.url ? {} : { url: `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}` })),
    },
  };
}
