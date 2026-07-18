'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, marketingActionFailure, logMarketingAudit } from '@/lib/marketing/admin';
import { buildMarketingPagePath, isMarketingPageType, normalizeMarketingSlug, pageTypeConfig, enqueueMarketingGenerationJob } from '@/lib/marketing/platform';
import type { Json } from '@/lib/database.types';

function value(fd: FormData, key: string): string {
  return String(fd.get(key) ?? '').trim();
}

function optional(fd: FormData, key: string): string | null {
  const v = value(fd, key);
  return v || null;
}

export async function createPlatformPage(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const pageType = value(formData, 'page_type');
  const title = value(formData, 'title');
  const slug = normalizeMarketingSlug(value(formData, 'slug') || title);
  if (!isMarketingPageType(pageType)) marketingActionFailure('create the marketing page', new Error('Choose a valid page type.'));
  if (!title || !slug) marketingActionFailure('create the marketing page', new Error('Title and slug are required.'));
  const path = buildMarketingPagePath(pageType, slug);
  const { data, error } = await supabase.from('marketing_pages').insert({
    page_type: pageType,
    slug,
    path,
    title,
    summary: optional(formData, 'summary'),
    body: optional(formData, 'body'),
    content: {},
    seo: {},
    aeo: {},
    status: 'draft',
    created_by: actorId,
    updated_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the marketing page', error ?? new Error('The page was not returned.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_page', resourceId: data.id, metadata: { pageType, path } });
  revalidatePath('/admin/marketing/platform');
}

export async function updatePlatformPage(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = value(formData, 'id');
  const pageType = value(formData, 'page_type');
  const title = value(formData, 'title');
  const slug = normalizeMarketingSlug(value(formData, 'slug') || title);
  if (!id || !isMarketingPageType(pageType) || !title || !slug) marketingActionFailure('update the marketing page', new Error('Page type, title, and slug are required.'));
  const path = buildMarketingPagePath(pageType, slug);
  const status = value(formData, 'status');
  const allowedStatus = ['draft', 'review', 'approved', 'published', 'archived'];
  const { data, error } = await supabase.from('marketing_pages').update({
    page_type: pageType,
    slug,
    path,
    title,
    summary: optional(formData, 'summary'),
    body: optional(formData, 'body'),
    status: allowedStatus.includes(status) ? status : 'draft',
    published_at: status === 'published' ? new Date().toISOString() : null,
    updated_by: actorId,
  }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing page', error ?? new Error('The page was not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_page', resourceId: id, metadata: { path, status } });
  revalidatePath('/admin/marketing/platform');
  revalidatePath(path);
}

export async function archivePlatformPage(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = value(formData, 'id');
  if (!id) return;
  const { data, error } = await supabase.from('marketing_pages').update({ status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId }).eq('id', id).is('deleted_at', null).select('path').maybeSingle();
  if (error || !data) marketingActionFailure('archive the marketing page', error ?? new Error('The page was not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_page', resourceId: id });
  revalidatePath('/admin/marketing/platform');
  revalidatePath(data.path);
}

export async function saveMarketingTemplate(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = optional(formData, 'id');
  const name = value(formData, 'name');
  const pageType = value(formData, 'page_type');
  if (!name || !isMarketingPageType(pageType)) marketingActionFailure('save the marketing template', new Error('Template name and page type are required.'));
  const payload = {
    name, page_type: pageType, description: optional(formData, 'description'), instructions: value(formData, 'instructions'),
    defaults: { cta_label: optional(formData, 'cta_label'), section_count: Number(value(formData, 'section_count') || 3) },
    schema: { fields: ['title', 'summary', 'body', 'seo', 'aeo'] }, status: 'active', is_default: formData.get('is_default') === 'on', updated_by: actorId,
  };
  const query = id
    ? supabase.from('marketing_content_templates').update(payload).eq('id', id).select('id').maybeSingle()
    : supabase.from('marketing_content_templates').insert({ ...payload, created_by: actorId }).select('id').maybeSingle();
  const { data, error } = await query;
  if (error || !data) marketingActionFailure('save the marketing template', error ?? new Error('The template was not returned.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: id ? 'update' : 'create', resource: 'marketing_content_template', resourceId: data.id });
  revalidatePath('/admin/marketing/platform');
}

export async function saveMarketingBrandRule(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = optional(formData, 'id');
  const ruleKey = value(formData, 'rule_key').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const name = value(formData, 'name');
  if (!ruleKey || !name) marketingActionFailure('save the brand rule', new Error('Rule key and name are required.'));
  const payload = { rule_key: ruleKey, name, instructions: value(formData, 'instructions'), value: { examples: value(formData, 'examples') }, active: formData.get('active') !== 'off', updated_by: actorId };
  const query = id
    ? supabase.from('marketing_brand_rules').update(payload).eq('id', id).select('id').maybeSingle()
    : supabase.from('marketing_brand_rules').insert(payload).select('id').maybeSingle();
  const { data, error } = await query;
  if (error || !data) marketingActionFailure('save the brand rule', error ?? new Error('The brand rule was not returned.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: id ? 'update' : 'create', resource: 'marketing_brand_rule', resourceId: data.id });
  revalidatePath('/admin/marketing/platform');
}

export async function retryMarketingJob(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = value(formData, 'id');
  if (!id) return;
  const { data: job, error: readError } = await supabase.from('marketing_generation_jobs').select('id, job_type, target_type, target_id, target_path, payload').eq('id', id).maybeSingle();
  if (readError || !job) marketingActionFailure('retry the marketing job', readError ?? new Error('The job was not found.'));
  const key = `${job.id}:manual:${Date.now()}`;
  await enqueueMarketingGenerationJob(supabase, { jobType: job.job_type, targetType: job.target_type, targetId: job.target_id, targetPath: job.target_path, idempotencyKey: key, payload: (job.payload as Record<string, unknown> | null) ?? {}, priority: 90, createdBy: actorId });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'retry', resource: 'marketing_generation_job', resourceId: id });
  revalidatePath('/admin/marketing/platform');
}
