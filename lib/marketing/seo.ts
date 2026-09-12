// lib/marketing/seo.ts — public reader that lets the admin SEO store
// (/admin/marketing/seo → marketing_seo_pages) drive the <title> and meta
// description of public routes. Active rows are world-readable (migration 0230).
// Every page passes a code fallback, so a missing/empty row never breaks SEO —
// the admin store simply overrides when present (the single source of truth).
import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

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
export async function resolveMarketingMetadata(path: string, fallback: Metadata): Promise<Metadata> {
  const seo = await getSeoPage(path);
  const title = seo?.title ?? fallback.title ?? undefined;
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
    openGraph: {
      ...priorOg,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    },
  };
}
