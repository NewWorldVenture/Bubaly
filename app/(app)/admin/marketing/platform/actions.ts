'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { AEO_TAG } from '@/lib/marketing/aeo';
import { requireMarketingAdmin, marketingActionFailure, logMarketingAudit } from '@/lib/marketing/admin';
import { buildMarketingPagePath, isMarketingPageType, normalizeMarketingSlug, pageTypeConfig, retireAeoQuestionsForPath } from '@/lib/marketing/platform';
import type { Json } from '@/lib/database.types';

function value(fd: FormData, key: string): string {
  return String(fd.get(key) ?? '').trim();
}

function optional(fd: FormData, key: string): string | null {
  const v = value(fd, key);
  return v || null;
}

/** A stored jsonb object's keys, so an edit can overlay only the keys its form
 *  renders. Anything that is not an object has no keys to keep. */
function jsonFields(stored: Json): { [key: string]: Json | undefined } {
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
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
  const nextStatus = allowedStatus.includes(status) ? status : 'draft';
  // The path the page's generated answers are filed under is the one stored NOW,
  // before this save: `slug` and `status` are in the same form, so one submit can
  // rename the page and take it down together, and the answers still carry the
  // old `source_path`. Retiring by the recomputed path alone retired nothing.
  const { data: stored, error: storedError } = await supabase.from('marketing_pages').select('path').eq('id', id).is('deleted_at', null).maybeSingle();
  if (storedError || !stored) marketingActionFailure('update the marketing page', storedError ?? new Error('The page was not found.'));
  const { data, error } = await supabase.from('marketing_pages').update({
    page_type: pageType,
    slug,
    path,
    title,
    summary: optional(formData, 'summary'),
    body: optional(formData, 'body'),
    status: nextStatus,
    published_at: status === 'published' ? new Date().toISOString() : null,
    updated_by: actorId,
  }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing page', error ?? new Error('The page was not found.'));
  // Taking the page out of 'published' bumps the version, so the 0237 trigger
  // queues a regeneration whose runQuestions eventually rewrites the answers at
  // 'answered' — but only those filed under the page's NEW path, which is all it
  // deletes and re-inserts. So retire here, now, and by every path that no longer
  // resolves: the old path after a rename (whether or not the page stays live —
  // no page holds it any more, so nothing would ever retire those answers), and
  // both paths when the page leaves the public set. "Eventually" is however long
  // the marketing cron takes; until then /faq and every sibling article keep
  // citing a page that is gone. Publishing is left to the generator.
  const gonePaths = new Set<string>();
  if (stored.path !== path) gonePaths.add(stored.path);
  if (nextStatus !== 'published') { gonePaths.add(stored.path); gonePaths.add(path); }
  for (const gonePath of gonePaths) {
    const { error: retireError } = await retireAeoQuestionsForPath(supabase, gonePath, ['marketing_platform']);
    if (retireError) marketingActionFailure("retire the page's published answers", retireError);
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_page', resourceId: id, metadata: { path, status } });
  revalidatePath('/admin/marketing/platform');
  revalidatePath(path);
  if (stored.path !== path) revalidatePath(stored.path);
  revalidateTag(AEO_TAG);
  revalidatePath('/faq');
}

export async function archivePlatformPage(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = value(formData, 'id');
  if (!id) return;
  const { data, error } = await supabase.from('marketing_pages').update({ status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId }).eq('id', id).is('deleted_at', null).select('path').maybeSingle();
  if (error || !data) marketingActionFailure('archive the marketing page', error ?? new Error('The page was not found.'));
  // Archive sets deleted_at, which switches the 0237 regeneration trigger OFF by
  // design — so this is the one path where nothing downstream will ever retire
  // the page's generated answers. Do it here, and fail loudly rather than leave
  // the public FAQ answering for a page the admin just took down. (Migration
  // 0383 makes the same retirement atomic in the database, for writers that
  // never come through this action.)
  const { error: retireError } = await retireAeoQuestionsForPath(supabase, data.path, ['marketing_platform']);
  if (retireError) marketingActionFailure("retire the archived page's published answers", retireError);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_page', resourceId: id });
  revalidatePath('/admin/marketing/platform');
  revalidatePath(data.path);
  // Public AEO reads are cached for an hour under one tag; without this the
  // retired answers keep rendering long after the page is gone.
  revalidateTag(AEO_TAG);
  revalidatePath('/faq');
}

export async function saveMarketingTemplate(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = optional(formData, 'id');
  const name = value(formData, 'name');
  const pageType = value(formData, 'page_type');
  if (!name || !isMarketingPageType(pageType)) marketingActionFailure('save the marketing template', new Error('Template name and page type are required.'));
  // Only what the form renders. The per-row editor posts these fields and
  // nothing else, so an edit must not also rewrite `status` (a 'draft' template
  // would silently go live) or `schema`, and must overlay its two `defaults`
  // keys on the ones the row already carries rather than replace the object.
  const edited = {
    name, page_type: pageType, description: optional(formData, 'description'), instructions: value(formData, 'instructions'),
    is_default: formData.get('is_default') === 'on', updated_by: actorId,
  };
  const editedDefaults = { cta_label: optional(formData, 'cta_label'), section_count: Number(value(formData, 'section_count') || 3) };
  let storedStatus = 'active';
  let defaults: Json = editedDefaults;
  if (id) {
    const { data: stored, error: readError } = await supabase.from('marketing_content_templates').select('status, defaults').eq('id', id).maybeSingle();
    if (readError || !stored) marketingActionFailure('save the marketing template', readError ?? new Error('The template was not found.'));
    storedStatus = stored.status;
    defaults = { ...jsonFields(stored.defaults), ...editedDefaults };
  }
  // Generation reads the ACTIVE default (platform.ts). Clearing the current one
  // is only right when this row is about to take its place: ticking the box on a
  // draft must not leave the page type with no template at all.
  // Which template generation uses right now, so a save that fails after the
  // clear can hand the page type its default back (SRV-001 l3). The clear has
  // to come first — uq_mkt_default_template_per_type (0237) refuses a second
  // active default — and the two are separate requests, so without this a
  // failed save left the type with NO default and every regeneration fell back
  // to the generic prompt. An atomic RPC would close the last window (both
  // writes failing); this closes the ordinary one without a migration.
  let previousDefaultId: string | null = null;
  if (edited.is_default && storedStatus === 'active') {
    const { data: prior, error: priorError } = await supabase.from('marketing_content_templates')
      .select('id').eq('page_type', pageType).eq('status', 'active').eq('is_default', true).maybeSingle();
    if (priorError) marketingActionFailure('prepare the default marketing template', priorError);
    previousDefaultId = prior?.id ?? null;
    // Deliberately NOT confirmed: this clears whichever template WAS the default
    // for the page type, and when none was, zero rows is exactly right. The
    // write that matters — the save below — is confirmed. Invisible to the
    // write ratchet until C1-S9-61, as the first statement in its block.
    // Audit C1-S9-61.
    const { error: clearDefaultError } = await supabase.from('marketing_content_templates')
      .update({ is_default: false, updated_by: actorId })
      .eq('page_type', pageType).eq('status', 'active');
    if (clearDefaultError) marketingActionFailure('prepare the default marketing template', clearDefaultError);
  }
  const query = id
    ? supabase.from('marketing_content_templates').update({ ...edited, defaults }).eq('id', id).select('id').maybeSingle()
    : supabase.from('marketing_content_templates').insert({
      ...edited, defaults, schema: { fields: ['title', 'summary', 'body', 'seo', 'aeo'] }, status: 'active', created_by: actorId,
    }).select('id').maybeSingle();
  const { data, error } = await query;
  if (error || !data) {
    if (previousDefaultId) {
      const { data: restored, error: restoreError } = await supabase.from('marketing_content_templates')
        .update({ is_default: true, updated_by: actorId }).eq('id', previousDefaultId).eq('page_type', pageType).select('id');
      if (restoreError || !restored?.length) {
        console.error('[marketing-template] the save failed and the previous default could not be restored; this page type has no default template', { pageType, previousDefaultId, restoreError: restoreError ?? 'no row was restored' });
      }
    }
    marketingActionFailure('save the marketing template', error ?? new Error('The template was not returned.'));
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: id ? 'update' : 'create', resource: 'marketing_content_template', resourceId: data.id });
  revalidatePath('/admin/marketing/platform');
}

export async function saveMarketingBrandRule(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = optional(formData, 'id');
  const ruleKey = value(formData, 'rule_key').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const name = value(formData, 'name');
  if (!ruleKey || !name) marketingActionFailure('save the brand rule', new Error('Rule key and name are required.'));
  // `=== 'on'` rather than `!== 'off'`: HTML omits an unchecked checkbox from the
  // submission entirely, so `!== 'off'` could never receive an "off" and every
  // rule was saved active whatever the operator ticked. Both forms that call this
  // action (the per-rule editor and the create form) render the checkbox, so a
  // missing key here means unchecked, which is what the operator asked for.
  const payload = { rule_key: ruleKey, name, instructions: value(formData, 'instructions'), active: formData.get('active') === 'on', updated_by: actorId };
  const examples = value(formData, 'examples');
  // `value` is a jsonb object the editor renders ONE key of. An edit overlays
  // `examples` on what the row already stores; replacing the object would drop
  // every other key the generator is fed (runRegeneration reads `value`).
  let ruleValue: Json = { examples };
  if (id) {
    const { data: stored, error: readError } = await supabase.from('marketing_brand_rules').select('value').eq('id', id).maybeSingle();
    if (readError || !stored) marketingActionFailure('save the brand rule', readError ?? new Error('The brand rule was not found.'));
    ruleValue = { ...jsonFields(stored.value), examples };
  }
  const query = id
    ? supabase.from('marketing_brand_rules').update({ ...payload, value: ruleValue }).eq('id', id).select('id').maybeSingle()
    : supabase.from('marketing_brand_rules').insert({ ...payload, value: ruleValue }).select('id').maybeSingle();
  const { data, error } = await query;
  if (error || !data) marketingActionFailure('save the brand rule', error ?? new Error('The brand rule was not returned.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: id ? 'update' : 'create', resource: 'marketing_brand_rule', resourceId: data.id });
  revalidatePath('/admin/marketing/platform');
}

/** The two statuses the queue card offers a Retry button for (page.tsx). */
const RETRYABLE_JOB_STATUS = ['failed', 'dead_letter'];

/**
 * Requeue the job the operator clicked on — the SAME row, in place.
 *
 * This used to clone the job under a fresh `${job.id}:manual:${Date.now()}`
 * idempotency key and leave the original untouched, which is two defects in one
 * line. Nothing else in the system moves a row out of 'failed'/'dead_letter':
 * `finishJob` and `failJob` both require `status = 'running'`, and
 * `claim_marketing_generation_jobs` (0237) only recovers stale *running* leases.
 * So the original stayed failed forever — the "Jobs needing review" tile could
 * never return to healthy and the Retry button never went away, which is exactly
 * what invites a second and a third click. And because the minted key was fresh
 * every time, the ON CONFLICT dedup in `enqueueMarketingGenerationJob` could not
 * catch those clicks: each one queued another full `regenerate_page` job, i.e.
 * another model completion that rewrites the live public page and clobbers the
 * `marketing_page_versions` snapshot for that version. (Two clicks inside one
 * millisecond did collide — and then silently did nothing at all.)
 *
 * Resetting in place keeps one row per unit of work: the tile clears, the button
 * disappears on the next render, and a second click finds nothing retryable and
 * enqueues nothing. `attempts` goes back to 0 because a manual retry means the
 * full retry budget again, and the status filter on the UPDATE is what makes the
 * second click a no-op rather than a race.
 */
export async function retryMarketingJob(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = value(formData, 'id');
  if (!id) return;
  const { data: job, error: readError } = await supabase.from('marketing_generation_jobs').select('id, status').eq('id', id).maybeSingle();
  if (readError || !job) marketingActionFailure('retry the marketing job', readError ?? new Error('The job was not found.'));
  // Only a job the queue card actually offered a Retry for. Without this a
  // hand-rolled POST could re-run a job that is running or already succeeded.
  // It is a no-op, not a failure, on purpose: the ordinary way to arrive here is
  // the second click of an impatient operator (or a stale tab) after the first
  // click already requeued the row — 'queued', 'running' or 'succeeded' is the
  // outcome that click asked for, so an error page would be wrong, nothing was
  // written, and the re-render shows the job's real status. The action returns
  // nothing to its form in either branch, so there is no "success" message to
  // mislead anyone.
  if (!RETRYABLE_JOB_STATUS.includes(job.status)) {
    revalidatePath('/admin/marketing/platform');
    return;
  }
  const { data: requeued, error } = await supabase.from('marketing_generation_jobs').update({
    status: 'queued',
    attempts: 0,
    run_after: new Date().toISOString(),
    locked_at: null,
    started_at: null,
    completed_at: null,
    error: null,
    priority: 90,
  }).eq('id', id).in('status', RETRYABLE_JOB_STATUS).select('id').maybeSingle();
  if (error) marketingActionFailure('retry the marketing job', error);
  // No row matched although the read above found one: a concurrent click already
  // requeued it. That is "already retried", not a failure — and it must NOT
  // become a second unit of work, so there is nothing more to do here.
  if (!requeued) {
    revalidatePath('/admin/marketing/platform');
    return;
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'retry', resource: 'marketing_generation_job', resourceId: id });
  revalidatePath('/admin/marketing/platform');
}
