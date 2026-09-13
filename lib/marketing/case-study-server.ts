import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { isCaseStudySlug } from './case-study';
import { isSyntheticSeedSlug } from './reputation';

export type CaseStudy = Pick<Database['public']['Tables']['case_studies']['Row'],
  'id' | 'title' | 'slug' | 'customer_name' | 'summary' | 'body' | 'result_metric'>;
export type CaseStudyResult = { ok: true; study: CaseStudy | null } | { ok: false };

/** Publication is checked on every request. A withdrawn story must not remain
 * publicly readable through a cached detail page or its metadata. */
export async function loadPublishedCaseStudy(db: SupabaseClient<Database>, slug: string): Promise<CaseStudyResult> {
  if (!isCaseStudySlug(slug)) return { ok: true, study: null };
  // A seeded row is never a customer story, whatever `is_published` says. The
  // list already refuses these; the detail page has to agree, or a link that
  // survived in a cache — or in a search index — still renders one.
  if (isSyntheticSeedSlug(slug)) return { ok: true, study: null };
  try {
    const { data, error } = await db.from('case_studies')
      .select('id, title, slug, customer_name, summary, body, result_metric, is_published')
      .eq('slug', slug).eq('is_published', true).maybeSingle();
    if (error) throw error;
    if (!data?.is_published) return { ok: true, study: null };
    const { id, title, customer_name, summary, body, result_metric } = data;
    return { ok: true, study: { id, title, slug: data.slug, customer_name, summary, body, result_metric } };
  } catch (error) {
    console.error('[customer-story] published story read failed', error);
    return { ok: false };
  }
}

export async function getPublishedCaseStudy(slug: string): Promise<CaseStudyResult> {
  try { return await loadPublishedCaseStudy(createServiceClient(), slug); }
  catch (error) {
    console.error('[customer-story] published story read failed', error);
    return { ok: false };
  }
}
