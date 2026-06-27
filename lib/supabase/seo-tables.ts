// Typed helpers for the programmatic-SEO tables added in migration 0092.
// The generated database.types.ts doesn't include these yet (pending migration),
// so we cast here rather than polluting the generated file — same pattern as
// withStripeTables / withGuardianTables.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeatureBlock, FaqItem } from '@/lib/seo/template';

export type SeoPageTemplateRow = {
  id: string;
  name: string;
  topic: string | null;
  slug_pattern: string;
  eyebrow: string | null;
  h1_template: string;
  subhead_template: string | null;
  meta_title_template: string | null;
  meta_description_template: string | null;
  intro_template: string | null;
  feature_blocks: FeatureBlock[];
  faqs: FaqItem[];
  cta_label: string | null;
  cta_href: string;
  static_vars: Record<string, string>;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SeoPageRow = {
  id: string;
  template_id: string;
  slug: string;
  variables: Record<string, string>;
  status: 'draft' | 'published';
  published_at: string | null;
  views: number;
  created_at: string;
  updated_at: string;
};

export type SeoTables = {
  seo_page_templates: SeoPageTemplateRow;
  seo_pages: SeoPageRow;
};

/** Cast a Supabase client to also query the SEO tables from migration 0092. */
export function withSeoTables<T extends SupabaseClient>(client: T) {
  return client as T & {
    from<K extends keyof SeoTables>(relation: K): ReturnType<T['from']>;
  };
}
