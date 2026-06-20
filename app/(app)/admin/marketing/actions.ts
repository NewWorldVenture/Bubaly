'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import type { SegmentRules, Lifecycle } from '@/lib/marketing/customers';

function str(v: FormDataEntryValue | null): string {
  return (v == null ? '' : String(v)).trim();
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
  if (!error && data) {
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_segment', resourceId: data.id, metadata: { name } });
  }
  revalidatePath('/admin/marketing/segments');
}

export async function archiveSegment(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  if (!id) return;
  await supabase.from('marketing_segments').update({ status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_segment', resourceId: id });
  revalidatePath('/admin/marketing/segments');
}

export async function createCampaign(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const budgetDollars = Number(formData.get('budgetDollars') || 0);

  const { data, error } = await supabase.from('marketing_campaigns').insert({
    name,
    objective: str(formData.get('objective')) || null,
    channel: str(formData.get('channel')) || 'email',
    type: str(formData.get('type')) || 'campaign',
    status: 'draft',
    segment_id: str(formData.get('segment_id')) || null,
    budget_cents: budgetDollars > 0 ? Math.round(budgetDollars * 100) : 0,
    starts_at: str(formData.get('starts_at')) || null,
    ends_at: str(formData.get('ends_at')) || null,
    notes: str(formData.get('notes')) || null,
    created_by: actorId,
  }).select('id').single();

  if (error || !data) { revalidatePath('/admin/marketing/campaigns'); return; }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_campaign', resourceId: data.id, metadata: { name } });
  revalidatePath('/admin/marketing/campaigns');
  redirect(`/admin/marketing/campaigns/${data.id}`);
}

export async function setCampaignStatus(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const status = str(formData.get('status'));
  if (!id || !status) return;
  await supabase.from('marketing_campaigns').update({ status, updated_by: actorId }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: `status:${status}`, resource: 'marketing_campaign', resourceId: id });
  revalidatePath(`/admin/marketing/campaigns/${id}`);
  revalidatePath('/admin/marketing/campaigns');
}

export async function createEmailDraft(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const subject = str(formData.get('subject'));
  if (!subject) return;
  const { data } = await supabase.from('marketing_email_campaigns').insert({
    subject,
    preview_text: str(formData.get('preview_text')) || null,
    body_html: str(formData.get('body_html')) || '',
    from_name: str(formData.get('from_name')) || null,
    segment_id: str(formData.get('segment_id')) || null,
    status: 'draft',
    created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_email_campaign', resourceId: data?.id ?? null, metadata: { subject } });
  revalidatePath('/admin/marketing/email');
}

export async function createContentItem(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = str(formData.get('title'));
  if (!title) return;
  const { data } = await supabase.from('marketing_content_items').insert({
    title,
    kind: str(formData.get('kind')) || 'blog',
    brief: str(formData.get('brief')) || null,
    status: 'idea',
    publish_at: str(formData.get('publish_at')) || null,
    created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_content_item', resourceId: data?.id ?? null, metadata: { title } });
  revalidatePath('/admin/marketing/content');
}

export async function addKeyword(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const keyword = str(formData.get('keyword'));
  if (!keyword) return;
  await supabase.from('marketing_seo_keywords').insert({
    keyword,
    intent: str(formData.get('intent')) || null,
    target_path: str(formData.get('target_path')) || null,
    source: 'manual',
    created_by: actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_seo_keyword', metadata: { keyword } });
  revalidatePath('/admin/marketing/seo');
}

export async function addAeoQuestion(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const question = str(formData.get('question'));
  if (!question) return;
  await supabase.from('marketing_aeo_questions').insert({
    question,
    answer: str(formData.get('answer')) || null,
    pattern: str(formData.get('pattern')) || null,
    entity: str(formData.get('entity')) || null,
    created_by: actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_aeo_question', metadata: { question } });
  revalidatePath('/admin/marketing/aeo');
}

export async function createSmsDraft(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const message = str(formData.get('message'));
  if (!message) return;
  const { data } = await supabase.from('marketing_sms_campaigns').insert({
    message, segment_id: str(formData.get('segment_id')) || null, status: 'draft', created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_sms_campaign', resourceId: data?.id ?? null });
  revalidatePath('/admin/marketing/sms');
}

export async function createSocialPost(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const content = str(formData.get('content'));
  if (!content) return;
  const { data } = await supabase.from('marketing_social_posts').insert({
    content, platform: str(formData.get('platform')) || 'instagram', link: str(formData.get('link')) || null,
    scheduled_at: str(formData.get('scheduled_at')) || null, status: str(formData.get('scheduled_at')) ? 'scheduled' : 'draft', created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_social_post', resourceId: data?.id ?? null });
  revalidatePath('/admin/marketing/social');
}

export async function createAdCampaign(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const budgetDollars = Number(formData.get('budgetDollars') || 0);
  const { data } = await supabase.from('marketing_ad_campaigns').insert({
    name, platform: str(formData.get('platform')) || 'meta', objective: str(formData.get('objective')) || null,
    budget_cents: budgetDollars > 0 ? Math.round(budgetDollars * 100) : 0, status: 'planned', created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_ad_campaign', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/ads');
}

export async function createAutomation(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const actions = formData.getAll('actions').map(String);
  const { data } = await supabase.from('marketing_automation_workflows').insert({
    name, trigger: str(formData.get('trigger')) || 'customer_created',
    steps: actions.map((a, i) => ({ order: i + 1, action: a })) as never,
    status: 'draft', created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_automation_workflow', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/automation');
}

export async function setAutomationStatus(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = str(formData.get('id'));
  const status = str(formData.get('status'));
  if (!id || !status) return;
  await supabase.from('marketing_automation_workflows').update({ status, updated_by: actorId }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: `status:${status}`, resource: 'marketing_automation_workflow', resourceId: id });
  revalidatePath('/admin/marketing/automation');
}

export async function createFunnel(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const steps = str(formData.get('steps')).split('\n').map((s) => s.trim()).filter(Boolean);
  const { data } = await supabase.from('marketing_funnels').insert({
    name, steps: steps.map((label, i) => ({ order: i + 1, label })) as never, created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_funnel', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/funnels');
}

export async function createLandingPage(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = str(formData.get('title'));
  const slug = str(formData.get('slug')).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!title || !slug) return;
  const { data } = await supabase.from('marketing_landing_pages').insert({
    title, slug, headline: str(formData.get('headline')) || null, subhead: str(formData.get('subhead')) || null,
    body: str(formData.get('body')) || null, status: 'draft', created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_landing_page', resourceId: data?.id ?? null, metadata: { slug } });
  revalidatePath('/admin/marketing/landing-pages');
}

export async function createForm(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = str(formData.get('name'));
  if (!name) return;
  const fields = str(formData.get('fields')).split(',').map((s) => s.trim()).filter(Boolean);
  const { data } = await supabase.from('marketing_forms').insert({
    name, fields: fields.map((label) => ({ label, key: label.toLowerCase().replace(/\s+/g, '_') })) as never, created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_form', resourceId: data?.id ?? null, metadata: { name } });
  revalidatePath('/admin/marketing/forms');
}

export async function saveSetting(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const key = str(formData.get('key'));
  if (!key) return;
  const value = str(formData.get('value'));
  await supabase.from('marketing_settings').upsert({ key, value: { text: value } as never, updated_by: actorId });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_setting', resourceId: key });
  revalidatePath('/admin/marketing/settings');
}
