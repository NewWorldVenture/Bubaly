import 'server-only';
import { CASE_STUDIES_CACHE_TAG } from './case-study';
// lib/marketing/reputation-server.ts — the public reader for testimonials and
// case studies. Only what an admin has PUBLISHED, used exactly as stored: the
// social-proof band renders nothing at all when both lists are empty, and a
// failed read is logged and treated as empty rather than filled in.
import { unstable_cache } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { clampRating, publishedOnly } from '@/lib/marketing/reputation';
import { withPublicReadBudget } from '@/lib/marketing/public-read';

export type PublicTestimonial = {
  id: string;
  authorName: string;
  authorRole: string | null;
  company: string | null;
  quote: string;
  /** 1–5, or null when the admin left it blank. */
  rating: number | null;
};

export type PublicCaseStudy = {
  id: string;
  slug: string;
  title: string;
  customerName: string | null;
  summary: string | null;
  resultMetric: string | null;
  /**
   * Set by an admin who has confirmed the outcome. The column lands with the
   * verified-outcome migration; until then it is simply absent and the public
   * "Verified outcome" badge never renders. Read loosely on purpose — the
   * generated types are not edited ahead of the schema.
   */
  verifiedAt: string | null;
};

const TESTIMONIAL_LIMIT = 6;
const CASE_STUDY_LIMIT = 3;

function isCaseStudyRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['id', 'title', 'slug'].every(key => typeof row[key] === 'string')
    && ['customer_name', 'summary', 'result_metric'].every(key => row[key] === null || typeof row[key] === 'string')
    && typeof row.is_published === 'boolean'
    // This column is absent before its migration; absence never earns a badge.
    && (row.verified_at === undefined || row.verified_at === null || typeof row.verified_at === 'string');
}

function isTestimonialRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['id', 'author_name', 'quote'].every(key => typeof row[key] === 'string')
    && ['author_role', 'company'].every(key => row[key] === null || typeof row[key] === 'string')
    && typeof row.is_published === 'boolean'
    && typeof row.sort_order === 'number' && Number.isFinite(row.sort_order)
    && (row.rating === null || (typeof row.rating === 'number' && Number.isFinite(row.rating)));
}

const cachedPublishedTestimonials = unstable_cache(
  (): Promise<PublicTestimonial[]> => withPublicReadBudget(async (signal) => {
    const { data, error } = await createServiceClient()
      .from('testimonials')
      .select('id, author_name, author_role, company, quote, rating, is_published, sort_order')
      .eq('is_published', true)
      .order('sort_order')
      .limit(TESTIMONIAL_LIMIT)
      .abortSignal(signal);
    if (error) throw error;
    if (!Array.isArray(data) || !data.every(isTestimonialRow)) throw new Error('Invalid published testimonials response');
    return publishedOnly(data).map((row) => ({
      id: row.id,
      authorName: row.author_name,
      authorRole: row.author_role,
      company: row.company,
      quote: row.quote,
      rating: clampRating(row.rating),
    }));
  }),
  ['public-testimonials-validated-v2'],
  { revalidate: 3600 },
);

/** Keep transient failures outside the cache, preserving last-good quotes. */
export async function getPublishedTestimonials(): Promise<PublicTestimonial[]> {
  try {
    return await cachedPublishedTestimonials();
  } catch (err) {
    console.error('[marketing-reputation] testimonials read failed', err);
    return [];
  }
}

const cachedPublishedCaseStudies = unstable_cache(
  (): Promise<PublicCaseStudy[]> => withPublicReadBudget(async (signal) => {
    const { data, error } = await createServiceClient()
      .from('case_studies')
      .select('*')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(CASE_STUDY_LIMIT)
      .abortSignal(signal);
    if (error) throw error;
    // Validate before filtering: a malformed row must not masquerade as a
    // legitimately empty publication list and become successful cached data.
    if (!Array.isArray(data) || !data.every(isCaseStudyRow)) throw new Error('Invalid published case studies response');
    return publishedOnly(data).map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      customerName: row.customer_name,
      summary: row.summary,
      resultMetric: row.result_metric,
      verifiedAt: (row as { verified_at?: string | null }).verified_at ?? null,
    }));
  }),
  ['public-case-studies-validated-v2'],
  { revalidate: 3600, tags: [CASE_STUDIES_CACHE_TAG] },
);

/** An outage is not a successfully empty publication list. */
export async function getPublishedCaseStudies(): Promise<PublicCaseStudy[]> {
  try {
    return await cachedPublishedCaseStudies();
  } catch (err) {
    console.error('[marketing-reputation] case studies read failed', err);
    return [];
  }
}
