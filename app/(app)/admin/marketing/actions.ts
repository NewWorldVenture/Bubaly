'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { archiveLegacyLandingOnPlatform, syncLegacyLandingToPlatform } from '@/lib/marketing/legacy-bridge';
import type { SegmentRules, Lifecycle } from '@/lib/marketing/customers';
import type { Json } from '@/lib/database.types';

function str(v: FormDataEntryValue | null): string {
  return (v == null ? '' : String(v)).trim();
}

const CAMPAIGN_CHANNELS = ['email', 'sms', 'social', 'ads', 'seo', 'aeo', 'content', 'referral', 'multi'] as const;
const CAMPAIGN_TYPES = ['campaign', 'launch', 're_engagement', 'win_back', 'referral', 'fundraising', 'retargeting'] as const;
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'completed', 'archived'] as const;
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube'] as const;
const AD_PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok', 'x'] as const;
const AUTOMATION_TRIGGERS = ['customer_created', 'joins_segment', 'form_submitted', 'payment_completed', 'payment_failed', 'email_opened', 'email_clicked', 'checkout_abandoned', 'customer_inactive', 'high_value_detected'] as const;
const AUTOMATION_ACTIONS = ['send_email', 'send_sms', 'add_to_segment', 'remove_from_segment', 'apply_tag', 'create_task', 'notify_admin', 'update_lead_score'] as const;
const AUTOMATION_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

function requireChoice<T extends string>(value: string, choices: readonly T[], label: string): T {
  if (!(choices as readonly string[]).includes(value)) throw new Error(`Invalid ${label}.`);
  return value as T;
}

function parseDollars(value: FormDataEntryValue | null, label: string): number {
  const raw = str(value);
  if (!raw) return 0;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`${label} must be a non-negative number.`);
  return Math.round(dollars * 100);
}

function parseDate(value: FormDataEntryValue | null, label: string): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date.`);
  return parsed.toISOString();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'campaign';
}

function trackedLink(value: string | null, source: string, campaign: string, medium: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://www.bubaly.com');
  } catch {
    throw new Error('Link must be a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Link must use http or https.');
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  return value.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

const CONTENT_KINDS = ['blog', 'landing', 'social', 'email', 'ad', 'seo_brief', 'aeo_brief'] as const;
const SEO_PAGE_STATUSES = ['active', 'noindex', 'archived'] as const;
const SEO_KEYWORD_STATUSES = ['idea', 'tracking', 'won', 'dropped'] as const;
const SEO_INTENTS = ['informational', 'navigational', 'commercial', 'transactional'] as const;
const AEO_PATTERNS = ['what_is', 'how_to', 'best_x_for_y', 'comparison', 'faq', 'local'] as const;
const AEO_STATUSES = ['opportunity', 'drafting', 'answered', 'published'] as const;

function optionalInt(value: string, min: number, max: number): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function normalizePublicPath(value: string): string | null {
  const path = value ? (value.startsWith('/') ? value : `/${value}`) : '';
  if (!path || path.length > 200 || !path.startsWith('/') || /^\/(admin|dashboard|api)(\/|$)/.test(path)) return null;
  return path === '/' ? '/' : path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

export async function createSegment(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;

  const lifecycle = formData.getAll('lifecycle').map(String) as Lifecycle[];
  const plans = formData.getAll('plans').map(String);
  const minLtvDollars = Number(formData.get('minLtvDollars') || 0);
  const inactiveForDays = Number(formData.get('inactiveForDays') || 0);

  const rules: SegmentRules = {
    ...(lifecycle.length ? { lifecycle } : {}),
    ...(plans.length ? { plans } : {}),
    ...(minLtvDollars > 0 ? { minLtvCents: Math.round(minLtvDollars * 100) } : {}),
    ...(inactiveForDays > 0 ? { inactiveForDays } : {}),
  };

  const { data, error } = await supabase.from('marketing_segments')
    .insert({ name, description: str(formData.get('description')) || null, kind: 'dynamic', rules: rules as never, created_by: actorId })
    .select('id').single();
  if (error || !data) marketingActionFailure('create the marketing segment', error ?? new Error('No segment was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_segment', resourceId: data.id, metadata: { name } });
  revalidatePath('/admin/marketing/segments');
}

export async function archiveSegment(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const { data, error } = await supabase.from('marketing_segments')
    .update({ status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId })
    .eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('archive the marketing segment', error ?? new Error('Marketing segment not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_segment', resourceId: id });
  revalidatePath('/admin/marketing/segments');
}

export async function createCampaign(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const channel = requireChoice(str(formData.get('channel')) || 'email', CAMPAIGN_CHANNELS, 'campaign channel');
  const type = requireChoice(str(formData.get('type')) || 'campaign', CAMPAIGN_TYPES, 'campaign type');
  const budgetCents = parseDollars(formData.get('budgetDollars'), 'Budget');
  const startsAt = parseDate(formData.get('starts_at'), 'Start date');
  const endsAt = parseDate(formData.get('ends_at'), 'End date');
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new Error('End date must be on or after the start date.');
  }

  const { data, error } = await supabase.from('marketing_campaigns').insert({
    name,
    objective: str(formData.get('objective')) || null,
    channel,
    type,
    status: 'draft',
    segment_id: str(formData.get('segment_id')) || null,
    budget_cents: budgetCents,
    starts_at: startsAt,
    ends_at: endsAt,
    notes: str(formData.get('notes')) || null,
    created_by: actorId,
  }).select('id').single();

  if (error || !data) marketingActionFailure('create the marketing campaign', error ?? new Error('No campaign was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_campaign', resourceId: data.id, metadata: { name } });
  revalidatePath('/admin/marketing/campaigns');
  redirect(`/admin/marketing/campaigns/${data.id}`);
}

export async function setCampaignStatus(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const status = requireChoice(str(formData.get('status')), CAMPAIGN_STATUSES, 'campaign status');
  if (!id || !status) return;
  const { data, error } = await supabase.from('marketing_campaigns')
    .update({ status, updated_by: actorId }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing campaign', error ?? new Error('Marketing campaign not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: `status:${status}`, resource: 'marketing_campaign', resourceId: id });
  revalidatePath(`/admin/marketing/campaigns/${id}`);
  revalidatePath('/admin/marketing/campaigns');
}

export async function createEmailDraft(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const subject = str(formData.get('subject'));
  if (!subject) return;
  const { data, error } = await supabase.from('marketing_email_campaigns').insert({
    subject,
    preview_text: str(formData.get('preview_text')) || null,
    body_html: str(formData.get('body_html')) || '',
    from_name: str(formData.get('from_name')) || null,
    segment_id: str(formData.get('segment_id')) || null,
    status: 'draft',
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the email draft', error ?? new Error('No email draft was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_email_campaign', resourceId: data?.id ?? null, metadata: { subject } });
  revalidatePath('/admin/marketing/email');
}

export async function createContentItem(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = str(formData.get('title'));
  if (!title) return;
  const requestedKind = str(formData.get('kind')) || 'blog';
  const kind = CONTENT_KINDS.includes(requestedKind as (typeof CONTENT_KINDS)[number]) ? requestedKind : 'blog';
  const { data, error } = await supabase.from('marketing_content_items').insert({
    title,
    kind,
    brief: str(formData.get('brief')) || null,
    status: 'idea',
    publish_at: str(formData.get('publish_at')) || null,
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the content item', error ?? new Error('No content item was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_content_item', resourceId: data?.id ?? null, metadata: { title } });
  revalidatePath('/admin/marketing/content');
}

export async function addKeyword(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const keyword = str(formData.get('keyword'));
  if (!keyword) return;
  const intent = str(formData.get('intent'));
  const targetPath = normalizePublicPath(str(formData.get('target_path')));
  if (intent && !SEO_INTENTS.includes(intent as (typeof SEO_INTENTS)[number])) {
    marketingActionFailure('add the SEO keyword', new Error('The SEO intent is invalid.'));
  }
  if (str(formData.get('target_path')) && !targetPath) {
    marketingActionFailure('add the SEO keyword', new Error('The SEO target path is invalid.'));
  }
  const { data, error } = await supabase.from('marketing_seo_keywords').insert({
    keyword,
    intent: intent || null,
    target_path: targetPath,
    source: 'manual',
    created_by: actorId,
  }).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('add the SEO keyword', error ?? new Error('No SEO keyword was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_seo_keyword', resourceId: data.id, metadata: { keyword } });
  revalidatePath('/admin/marketing/seo');
}

export async function addAeoQuestion(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const question = str(formData.get('question'));
  if (!question) return;
  const answer = str(formData.get('answer'));
  const pattern = str(formData.get('pattern'));
  if (pattern && !AEO_PATTERNS.includes(pattern as (typeof AEO_PATTERNS)[number])) {
    marketingActionFailure('add the AEO question', new Error('The AEO pattern is invalid.'));
  }
  const { data, error } = await supabase.from('marketing_aeo_questions').insert({
    question,
    answer: answer || null,
    pattern: pattern || null,
    entity: str(formData.get('entity')) || null,
    status: answer ? 'drafting' : 'opportunity',
    created_by: actorId,
  }).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('add the AEO question', error ?? new Error('No AEO question was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_aeo_question', resourceId: data.id, metadata: { question } });
  revalidatePath('/admin/marketing/aeo');
}

export async function updateAeoQuestion(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const question = str(formData.get('question'));
  const answer = str(formData.get('answer'));
  const pattern = str(formData.get('pattern'));
  const status = str(formData.get('status')) || 'opportunity';
  const scoreInput = str(formData.get('clarity_score'));
  const clarityScore = optionalInt(scoreInput, 0, 100);
  if (!id || !question) return;
  if (pattern && !AEO_PATTERNS.includes(pattern as (typeof AEO_PATTERNS)[number])) {
    marketingActionFailure('update the AEO question', new Error('The AEO pattern is invalid.'));
  }
  if (!AEO_STATUSES.includes(status as (typeof AEO_STATUSES)[number])) {
    marketingActionFailure('update the AEO question', new Error('The AEO status is invalid.'));
  }
  if (scoreInput && clarityScore === null) {
    marketingActionFailure('update the AEO question', new Error('The AEO clarity score must be between 0 and 100.'));
  }
  if (status === 'published' && !answer) {
    marketingActionFailure('publish the AEO question', new Error('A published AEO question must include an answer.'));
  }
  const { data, error } = await supabase.from('marketing_aeo_questions').update({
    question,
    answer: answer || null,
    entity: str(formData.get('entity')) || null,
    source_path: normalizePublicPath(str(formData.get('source_path'))),
    pattern: pattern || null,
    status,
    clarity_score: clarityScore,
    last_reviewed: new Date().toISOString(),
  }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the AEO question', error ?? new Error('AEO question not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: status === 'published' ? 'publish' : 'update', resource: 'marketing_aeo_question', resourceId: id, metadata: { status } });
  revalidatePath('/admin/marketing/aeo');
  revalidatePath('/faq');
}

export async function deleteAeoQuestion(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const { data, error } = await supabase.from('marketing_aeo_questions').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the AEO question', error ?? new Error('AEO question not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_aeo_question', resourceId: id });
  revalidatePath('/admin/marketing/aeo');
  revalidatePath('/faq');
}

export async function updateSeoKeyword(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const keyword = str(formData.get('keyword'));
  const intent = str(formData.get('intent'));
  const targetPathInput = str(formData.get('target_path'));
  const targetPath = normalizePublicPath(targetPathInput);
  const status = str(formData.get('status')) || 'tracking';
  if (!id || !keyword) return;
  if (intent && !SEO_INTENTS.includes(intent as (typeof SEO_INTENTS)[number])) {
    marketingActionFailure('update the SEO keyword', new Error('The SEO intent is invalid.'));
  }
  if (targetPathInput && !targetPath) {
    marketingActionFailure('update the SEO keyword', new Error('The SEO target path is invalid.'));
  }
  if (!SEO_KEYWORD_STATUSES.includes(status as (typeof SEO_KEYWORD_STATUSES)[number])) {
    marketingActionFailure('update the SEO keyword', new Error('The SEO keyword status is invalid.'));
  }
  const { data, error } = await supabase.from('marketing_seo_keywords').update({
    keyword,
    intent: intent || null,
    target_path: targetPath,
    status,
  }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the SEO keyword', error ?? new Error('SEO keyword not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: status === 'dropped' ? 'drop' : 'update', resource: 'marketing_seo_keyword', resourceId: id, metadata: { keyword, status } });
  revalidatePath('/admin/marketing/seo');
}

export async function archiveSeoKeyword(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) marketingActionFailure('archive the SEO keyword', new Error('SEO keyword id is required.'));
  const { data, error } = await supabase.from('marketing_seo_keywords').update({ status: 'dropped' })
    .eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('archive the SEO keyword', error ?? new Error('SEO keyword not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_seo_keyword', resourceId: id });
  revalidatePath('/admin/marketing/seo');
}

export async function saveSeoPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const pathInput = str(formData.get('path'));
  const path = normalizePublicPath(pathInput);
  const title = str(formData.get('title'));
  const description = str(formData.get('meta_description'));
  const status = str(formData.get('status')) || 'active';
  const scoreInput = str(formData.get('score'));
  const score = optionalInt(scoreInput, 0, 100);
  if (!path) marketingActionFailure('save the SEO page', new Error('The SEO page path is invalid.'));
  if (!SEO_PAGE_STATUSES.includes(status as (typeof SEO_PAGE_STATUSES)[number])) {
    marketingActionFailure('save the SEO page', new Error('The SEO page status is invalid.'));
  }
  if (scoreInput && score === null) {
    marketingActionFailure('save the SEO page', new Error('The SEO score must be between 0 and 100.'));
  }
  const values = {
    title: title || null,
    meta_description: description || null,
    status,
    score,
    last_audited_at: new Date().toISOString(),
  };
  const query = id
    ? supabase.from('marketing_seo_pages').update({ path, ...values } as never).eq('id', id).select('id, path').maybeSingle()
    : supabase.from('marketing_seo_pages').upsert({ path, ...values }, { onConflict: 'path' }).select('id, path').single();
  const { data, error } = await query;
  if (error || !data) marketingActionFailure('save the SEO page', error ?? new Error('The SEO page row was not returned after save.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: id ? 'update' : 'create', resource: 'marketing_seo_page', resourceId: data.id, metadata: { path } });
  revalidatePath('/admin/marketing/seo');
}

export async function archiveSeoPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const { data, error } = await supabase.from('marketing_seo_pages').update({ status: 'archived' }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('archive the SEO page', error ?? new Error('SEO page not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_seo_page', resourceId: id });
  revalidatePath('/admin/marketing/seo');
}

export async function createSmsDraft(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const message = str(formData.get('message'));
  if (!message) return;
  if (message.length > 320) throw new Error('SMS messages must be 320 characters or fewer.');
  const { data, error } = await supabase.from('marketing_sms_campaigns').insert({
    message, segment_id: str(formData.get('segment_id')) || null, status: 'draft', created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the SMS draft', error ?? new Error('No SMS draft was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_sms_campaign', resourceId: data?.id ?? null });
  revalidatePath('/admin/marketing/sms');
}

export async function createSocialPost(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const content = str(formData.get('content'));
  if (!content) return;
  const platform = requireChoice(str(formData.get('platform')) || 'instagram', SOCIAL_PLATFORMS, 'social platform');
  const scheduledAt = parseDate(formData.get('scheduled_at'), 'Schedule time');
  if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) throw new Error('Schedule time must be in the future.');
  const campaignKey = slug(content);
  const link = trackedLink(str(formData.get('link')) || null, platform, campaignKey, 'social');
  const { data, error } = await supabase.from('marketing_social_posts').insert({
    content, platform, link,
    scheduled_at: scheduledAt, status: scheduledAt ? 'scheduled' : 'draft',
    metadata: { utm_source: platform, utm_medium: 'social', utm_campaign: campaignKey } as never,
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the social post', error ?? new Error('No social post was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_social_post', resourceId: data?.id ?? null });
  revalidatePath('/admin/marketing/social');
}

export async function createAdCampaign(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const platform = requireChoice(str(formData.get('platform')) || 'meta', AD_PLATFORMS, 'advertising platform');
  const budgetCents = parseDollars(formData.get('budgetDollars'), 'Budget');
  const campaignKey = slug(name);
  const { data, error } = await supabase.from('marketing_ad_campaigns').insert({
    name, platform, objective: str(formData.get('objective')) || null,
    budget_cents: budgetCents, status: 'planned',
    utm: { source: platform, medium: 'paid', campaign: campaignKey } as never,
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the advertising campaign', error ?? new Error('No ad campaign was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_ad_campaign', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/ads');
}

export async function createAutomation(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const trigger = requireChoice(str(formData.get('trigger')) || 'customer_created', AUTOMATION_TRIGGERS, 'automation trigger');
  const actions = formData.getAll('actions').map(String);
  if (actions.length === 0) throw new Error('Choose at least one automation action.');
  if (actions.some((action) => !(AUTOMATION_ACTIONS as readonly string[]).includes(action))) throw new Error('Invalid automation action.');
  const { data, error } = await supabase.from('marketing_automation_workflows').insert({
    name, trigger,
    steps: actions.map((a, i) => ({ order: i + 1, action: a })) as never,
    status: 'draft', created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the automation workflow', error ?? new Error('No automation workflow was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_automation_workflow', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/automation');
}

export async function setAutomationStatus(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const status = requireChoice(str(formData.get('status')), AUTOMATION_STATUSES, 'automation status');
  if (!id || !status) return;
  const { data, error } = await supabase.from('marketing_automation_workflows')
    .update({ status, updated_by: actorId }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the automation workflow', error ?? new Error('Automation workflow not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: `status:${status}`, resource: 'marketing_automation_workflow', resourceId: id });
  revalidatePath('/admin/marketing/automation');
}

export async function createFunnel(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const steps = str(formData.get('steps')).split('\n').map((s) => s.trim()).filter(Boolean);
  const { data, error } = await supabase.from('marketing_funnels').insert({
    name, steps: steps.map((label, i) => ({ order: i + 1, label })) as never, created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the funnel', error ?? new Error('No funnel was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_funnel', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/funnels');
}

export async function createLandingPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = str(formData.get('title'));
  const slug = str(formData.get('slug')).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!title || !slug) return;
  const ctaLabel = str(formData.get('cta_label'));
  const ctaHref = str(formData.get('cta_href'));
  const metadata: Record<string, string> = {};
  if (ctaLabel) metadata.cta_label = ctaLabel;
  if (ctaHref) metadata.cta_href = ctaHref;
  const { data, error } = await supabase.from('marketing_landing_pages').insert({
    title, slug, headline: str(formData.get('headline')) || null, subhead: str(formData.get('subhead')) || null,
    body: str(formData.get('body')) || null, status: 'draft', created_by: actorId,
    metadata,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the landing page', error ?? new Error('No landing page was created'));
  await syncLegacyLandingToPlatform(supabase, {
    id: data.id,
    slug,
    title,
    headline: str(formData.get('headline')) || null,
    subhead: str(formData.get('subhead')) || null,
    body: str(formData.get('body')) || null,
    metadata: metadata as unknown as Json,
    published: false,
    publishedAt: null,
    actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_landing_page', resourceId: data?.id ?? null, metadata: { slug } });
  revalidatePath('/admin/marketing/landing-pages');
}

/** Publish or unpublish a landing page (controls public visibility at /lp/<slug>). */
export async function setLandingPublished(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const publish = str(formData.get('publish')) === '1';
  const { data, error } = await supabase.from('marketing_landing_pages')
    .update({ published: publish, status: publish ? 'published' : 'draft' })
    .eq('id', id).is('deleted_at', null).select('id, slug').maybeSingle();
  if (error || !data) marketingActionFailure('update the landing page', error ?? new Error('Landing page not found'));
  const { data: landing, error: landingError } = await supabase.from('marketing_landing_pages')
    .select('id, slug, title, headline, subhead, body, metadata, published')
    .eq('id', id).is('deleted_at', null).maybeSingle();
  if (landingError) marketingActionFailure('load the landing page for synchronization', landingError);
  if (landing) await syncLegacyLandingToPlatform(supabase, {
    id: landing.id,
    slug: landing.slug,
    title: landing.title,
    headline: landing.headline,
    subhead: landing.subhead,
    body: landing.body,
    metadata: (landing.metadata ?? {}) as unknown as Json,
    published: landing.published,
    publishedAt: landing.published ? new Date().toISOString() : null,
    actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: publish ? 'publish' : 'unpublish', resource: 'marketing_landing_page', resourceId: id });
  revalidatePath('/admin/marketing/landing-pages');
  revalidatePath(`/lp/${data.slug}`);
}

export async function updateLandingPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const title = str(formData.get('title'));
  const slug = str(formData.get('slug')).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!id || !title || !slug) return;

  const { data: existing, error: readError } = await supabase.from('marketing_landing_pages')
    .select('id, slug, metadata, published, status').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !existing) marketingActionFailure('find the landing page', readError ?? new Error('Landing page not found.'));

  const currentMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
  const ctaLabel = str(formData.get('cta_label'));
  const ctaHref = str(formData.get('cta_href'));
  const metadata = {
    ...currentMetadata,
    ...(ctaLabel ? { cta_label: ctaLabel } : { cta_label: null }),
    ...(ctaHref ? { cta_href: ctaHref } : { cta_href: null }),
  };
  const { data, error } = await supabase.from('marketing_landing_pages').update({
    title,
    slug,
    headline: str(formData.get('headline')) || null,
    subhead: str(formData.get('subhead')) || null,
    body: str(formData.get('body')) || null,
    metadata,
  }).eq('id', id).is('deleted_at', null).select('id, slug').maybeSingle();
  if (error || !data) marketingActionFailure('update the landing page', error ?? new Error('Landing page not found.'));
  const { data: landing, error: landingError } = await supabase.from('marketing_landing_pages')
    .select('id, slug, title, headline, subhead, body, metadata, published')
    .eq('id', id).is('deleted_at', null).maybeSingle();
  if (landingError) marketingActionFailure('load the landing page for synchronization', landingError);
  if (landing) await syncLegacyLandingToPlatform(supabase, {
    id: landing.id,
    slug: landing.slug,
    title: landing.title,
    headline: landing.headline,
    subhead: landing.subhead,
    body: landing.body,
    metadata: (landing.metadata ?? {}) as unknown as Json,
    published: landing.published,
    publishedAt: landing.published ? new Date().toISOString() : null,
    actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_landing_page', resourceId: id, metadata: { slug } });
  revalidatePath('/admin/marketing/landing-pages');
  revalidatePath(`/lp/${existing.slug}`);
  revalidatePath(`/lp/${data.slug}`);
}

export async function archiveLandingPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const archiveValues = {
    published: false,
    status: 'archived',
    deleted_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('marketing_landing_pages').update(archiveValues as never)
    .eq('id', id).is('deleted_at', null).select('id, slug').maybeSingle();
  if (error || !data) marketingActionFailure('archive the landing page', error ?? new Error('Landing page not found.'));
  await archiveLegacyLandingOnPlatform(supabase, data.slug, actorId);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_landing_page', resourceId: id });
  revalidatePath('/admin/marketing/landing-pages');
  revalidatePath(`/lp/${data.slug}`);
}

export async function createForm(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const fields = str(formData.get('fields')).split(',').map((s) => s.trim()).filter(Boolean);
  const { data, error } = await supabase.from('marketing_forms').insert({
    name, fields: fields.map((label) => ({ label, key: label.toLowerCase().replace(/\s+/g, '_') })) as never, created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the marketing form', error ?? new Error('No form was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_form', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/forms');
}

export async function setFormStatus(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  const activate = str(formData.get('activate')) === '1';
  const { data, error } = await supabase.from('marketing_forms')
    .update({ status: activate ? 'active' : 'archived' })
    .eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing form', error ?? new Error('Marketing form not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: activate ? 'activate' : 'archive', resource: 'marketing_form', resourceId: id });
  revalidatePath('/admin/marketing/forms');
}

export async function saveSetting(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const key = str(formData.get('key'));
  if (!key) return;
  const value = str(formData.get('value'));
  const { data, error } = await supabase.from('marketing_settings')
    .upsert({ key, value: { text: value } as never, updated_by: actorId })
    .select('key').maybeSingle();
  if (error || !data) marketingActionFailure('save the marketing setting', error ?? new Error('Marketing setting was not saved'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_setting', resourceId: data.key });
  revalidatePath('/admin/marketing/settings');
}
