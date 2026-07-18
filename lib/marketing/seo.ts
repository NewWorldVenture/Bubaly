// lib/marketing/seo.ts — public reader that lets the admin SEO store
// (/admin/marketing/seo → marketing_seo_pages) drive the <title> and meta
// description of public routes. Active rows are world-readable (migration 0230).
// Every page passes a code fallback, so a missing/empty row never breaks SEO —
// the admin store simply overrides when present (the single source of truth).
import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function getSeoPage(path: string): Promise<{ title: string | null; description: string | null } | null> {
  try {
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
      .maybeSingle();
    if (platform) {
      const seo = platform.seo && typeof platform.seo === 'object' && !Array.isArray(platform.seo)
        ? platform.seo as { title?: unknown; description?: unknown }
        : {};
      return {
        title: typeof seo.title === 'string' && seo.title.trim() ? seo.title : platform.title,
        description: typeof seo.description === 'string' && seo.description.trim() ? seo.description : platform.summary,
      };
    }
    const { data } = await client
      .from('marketing_seo_pages')
      .select('title, meta_description, status')
      .eq('path', path)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return null;
    return { title: data.title, description: data.meta_description };
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
  const priorOg = (fallback.openGraph ?? {}) as Record<string, unknown>;
  return {
    ...fallback,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    openGraph: {
      ...priorOg,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    },
  };
}
