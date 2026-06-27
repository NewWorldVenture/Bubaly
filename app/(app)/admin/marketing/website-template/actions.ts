'use server';

import { revalidatePath } from 'next/cache';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables, type SeoPageTemplateRow } from '@/lib/supabase/seo-tables';
import { resolveSlug, slugify, mergeVars, type SeoTemplate, type FeatureBlock, type FaqItem } from '@/lib/seo/template';
import { US_STATES, stateVars } from '@/lib/seo/states';

type Result = { ok: true } | { ok: false; error: string };

async function guard() {
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) throw new Error('Forbidden: admin only');
  return { supabase: withSeoTables(createServiceClient()), userId: user.id };
}

function revalidate() {
  revalidatePath('/admin/marketing/website-template');
}

export type TemplateInput = {
  id?: string;
  name: string;
  topic: string | null;
  slugPattern: string;
  eyebrow: string | null;
  h1Template: string;
  subheadTemplate: string | null;
  metaTitleTemplate: string | null;
  metaDescriptionTemplate: string | null;
  introTemplate: string | null;
  featureBlocks: FeatureBlock[];
  faqs: FaqItem[];
  ctaLabel: string | null;
  ctaHref: string;
  staticVars: Record<string, string>;
  isActive: boolean;
};

export async function upsertTemplateAction(input: TemplateInput): Promise<Result & { id?: string }> {
  const { supabase, userId } = await guard();
  if (!input.name.trim()) return { ok: false, error: 'Name is required.' };
  if (!input.slugPattern.trim()) return { ok: false, error: 'Slug pattern is required.' };
  if (!input.h1Template.trim()) return { ok: false, error: 'Headline (H1) is required.' };

  const payload = {
    name: input.name.trim(),
    topic: input.topic?.trim() || null,
    slug_pattern: input.slugPattern.trim(),
    eyebrow: input.eyebrow?.trim() || null,
    h1_template: input.h1Template.trim(),
    subhead_template: input.subheadTemplate?.trim() || null,
    meta_title_template: input.metaTitleTemplate?.trim() || null,
    meta_description_template: input.metaDescriptionTemplate?.trim() || null,
    intro_template: input.introTemplate ?? null,
    feature_blocks: input.featureBlocks ?? [],
    faqs: input.faqs ?? [],
    cta_label: input.ctaLabel?.trim() || null,
    cta_href: input.ctaHref?.trim() || '/signup',
    static_vars: input.staticVars ?? {},
    is_active: input.isActive,
  };

  const from = () => supabase.from('seo_page_templates') as ReturnType<typeof supabase.from>;
  if (input.id) {
    const { error } = await from().update(payload).eq('id', input.id);
    if (error) return { ok: false, error: error.message };
    revalidate();
    return { ok: true, id: input.id };
  }
  const { data, error } = await from().insert({ ...payload, created_by: userId }).select('id').single();
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true, id: (data as { id: string }).id };
}

/** Clone a template (without its pages) as a fast starting point for a variation. */
export async function duplicateTemplateAction(input: { id: string }): Promise<Result & { id?: string }> {
  const { supabase, userId } = await guard();
  const { data: src, error: sErr } = await supabase
    .from('seo_page_templates').select('*').eq('id', input.id).maybeSingle();
  if (sErr) return { ok: false, error: sErr.message };
  if (!src) return { ok: false, error: 'Template not found.' };
  const t = src as SeoPageTemplateRow;
  const { id, created_at, updated_at, created_by, ...rest } = t;
  void id; void created_at; void updated_at; void created_by;
  const { data, error } = await (supabase.from('seo_page_templates') as ReturnType<typeof supabase.from>)
    .insert({ ...rest, name: `${t.name} (copy)`, is_active: false, created_by: userId })
    .select('id').single();
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true, id: (data as { id: string }).id };
}

export async function deleteTemplateAction(input: { id: string }): Promise<Result> {
  const { supabase } = await guard();
  // Cascade deletes the template's pages (FK on delete cascade).
  const { error } = await (supabase.from('seo_page_templates') as ReturnType<typeof supabase.from>).delete().eq('id', input.id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/**
 * Generate (upsert) one page per selected state for a template. Existing pages
 * with the same slug are left in place (idempotent) so re-generating after an
 * edit never duplicates or clobbers publish state.
 */
export async function generatePagesAction(input: {
  templateId: string;
  stateAbbrs: string[];
  // Optional second dimension ("other criteria") — a custom variable + values.
  custom?: { key: string; values: string[] } | null;
  // When a custom dimension is set: cartesian with states, else custom-only.
  combineWithStates?: boolean;
  publish: boolean;
}): Promise<Result & { created?: number; skipped?: number }> {
  const { supabase } = await guard();

  const { data: tplRow, error: tErr } = await supabase
    .from('seo_page_templates')
    .select('*')
    .eq('id', input.templateId)
    .maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  if (!tplRow) return { ok: false, error: 'Template not found.' };
  const template = tplRow as unknown as SeoTemplate & SeoPageTemplateRow;

  const states = US_STATES.filter((s) => input.stateAbbrs.includes(s.abbr));
  const custom = input.custom && input.custom.key.trim() && input.custom.values.length
    ? { key: input.custom.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'), values: input.custom.values }
    : null;

  // Build the list of variable sets to generate from the chosen dimensions.
  const varSets = buildVarSets(states, custom, input.combineWithStates ?? false);
  if (varSets.length === 0) return { ok: false, error: 'Pick at least one state or add custom criteria values.' };

  // Existing slugs for this template, to skip duplicates.
  const { data: existing } = await supabase
    .from('seo_pages')
    .select('slug')
    .eq('template_id', input.templateId);
  const existingSlugs = new Set((existing ?? []).map((r: { slug: string }) => r.slug));

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const pageVars of varSets) {
    const slug = resolveSlug(template.slug_pattern, mergeVars(template, pageVars));
    if (!slug || existingSlugs.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({
      template_id: input.templateId,
      slug,
      variables: pageVars,
      status: input.publish ? 'published' : 'draft',
      published_at: input.publish ? new Date().toISOString() : null,
    });
  }

  if (rows.length === 0) return { ok: true, created: 0, skipped: varSets.length };

  const { error } = await (supabase.from('seo_pages') as ReturnType<typeof supabase.from>).insert(rows);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true, created: rows.length, skipped: varSets.length - rows.length };
}

/** Expand the selected dimensions into one variable set per page. */
function buildVarSets(
  states: typeof US_STATES,
  custom: { key: string; values: string[] } | null,
  combine: boolean,
): Record<string, string>[] {
  const customVars = (v: string): Record<string, string> => ({ [custom!.key]: v, [`${custom!.key}_slug`]: slugify(v) });

  if (custom && combine && states.length > 0) {
    const out: Record<string, string>[] = [];
    for (const s of states) for (const v of custom.values) out.push({ ...stateVars(s), ...customVars(v) });
    return out;
  }
  if (custom) return custom.values.map(customVars);
  return states.map((s) => stateVars(s));
}

export async function setPageStatusAction(input: { ids: string[]; status: 'draft' | 'published' }): Promise<Result> {
  const { supabase } = await guard();
  if (input.ids.length === 0) return { ok: false, error: 'No pages selected.' };
  const { error } = await (supabase.from('seo_pages') as ReturnType<typeof supabase.from>)
    .update({ status: input.status, published_at: input.status === 'published' ? new Date().toISOString() : null })
    .in('id', input.ids);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function deletePagesAction(input: { ids: string[] }): Promise<Result> {
  const { supabase } = await guard();
  if (input.ids.length === 0) return { ok: false, error: 'No pages selected.' };
  const { error } = await (supabase.from('seo_pages') as ReturnType<typeof supabase.from>).delete().in('id', input.ids);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Publish or unpublish every page belonging to a template in one click. */
export async function setTemplatePagesStatusAction(input: { templateId: string; status: 'draft' | 'published' }): Promise<Result> {
  const { supabase } = await guard();
  const { error } = await (supabase.from('seo_pages') as ReturnType<typeof supabase.from>)
    .update({ status: input.status, published_at: input.status === 'published' ? new Date().toISOString() : null })
    .eq('template_id', input.templateId);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
