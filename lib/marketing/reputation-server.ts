import 'server-only';
import { CASE_STUDIES_CACHE_TAG } from './case-study';
// lib/marketing/reputation-server.ts — the public reader for testimonials and
// case studies. Only what an admin has PUBLISHED, used exactly as stored: the
// social-proof band renders nothing at all when both lists are empty, and a
// failed read is logged and treated as empty rather than filled in.
import { unstable_cache } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { clampRating, publishedOnly } from '@/lib/marketing/reputation';

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

export const getPublishedTestimonials = unstable_cache(
  async (): Promise<PublicTestimonial[]> => {
    try {
      const { data, error } = await createServiceClient()
        .from('testimonials')
        .select('id, author_name, author_role, company, quote, rating, is_published, sort_order')
        .eq('is_published', true)
        .order('sort_order')
        .limit(TESTIMONIAL_LIMIT);
      if (error) throw error;
      return publishedOnly(data ?? []).map((row) => ({
        id: row.id,
        authorName: row.author_name,
        authorRole: row.author_role,
        company: row.company,
        quote: row.quote,
        rating: clampRating(row.rating),
      }));
    } catch (err) {
      console.error('[marketing-reputation] testimonials read failed', err);
      return [];
    }
  },
  ['public-testimonials'],
  { revalidate: 3600 },
);

export const getPublishedCaseStudies = unstable_cache(
  async (): Promise<PublicCaseStudy[]> => {
    try {
      const { data, error } = await createServiceClient()
        .from('case_studies')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(CASE_STUDY_LIMIT);
      if (error) throw error;
      return publishedOnly(data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        slug: row.slug,
        customerName: row.customer_name,
        summary: row.summary,
        resultMetric: row.result_metric,
        verifiedAt: (row as { verified_at?: string | null }).verified_at ?? null,
      }));
    } catch (err) {
      console.error('[marketing-reputation] case studies read failed', err);
      return [];
    }
  },
  ['public-case-studies'],
  { revalidate: 3600, tags: [CASE_STUDIES_CACHE_TAG] },
);
