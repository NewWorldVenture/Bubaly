'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { normalizeTrigger } from '@/lib/marketing/exit-intent';
import { safeHref } from '@/lib/marketing/landing';
import type { AudienceMatch } from '@/lib/marketing/personalization';
import type { Json } from '@/lib/database.types';
import { refuseInput } from '@/lib/actions/refusal';

// An offer is shown to every matching public visitor, so its copy is bounded
// and its link is a same-site path or an http(s) URL, as a landing CTA's is.
const HEADLINE_MAX = 120;
const BODY_MAX = 600;
const CTA_LABEL_MAX = 40;

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function list(fd: FormData, k: string): string[] {
  return (s(fd, k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function buildMatch(fd: FormData): AudienceMatch {
  const m: AudienceMatch = {};
  const source = list(fd, 'source'); if (source.length) m.source = source;
  const medium = list(fd, 'medium'); if (medium.length) m.medium = medium;
  const campaign = list(fd, 'campaign'); if (campaign.length) m.campaign = campaign;
  const segments = list(fd, 'segments'); if (segments.length) m.segments = segments;
  const paths = list(fd, 'paths'); if (paths.length) m.paths = paths;
  const countries = list(fd, 'countries'); if (countries.length) m.countries = countries;
  const returning = s(fd, 'returning');
  if (returning === 'true') m.returning = true;
  else if (returning === 'false') m.returning = false;
  // Segments and session counts have no trusted source: the resolve route
  // would have to take them from the visitor's own request body. An offer
  // targeted by them reached no genuine visitor and anyone who forged them.
  if (m.segments || s(fd, 'minSessions')) refuseInput('Segment and session-count targeting is not available for exit-intent offers.');
  return m;
}

export async function createExitIntentAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = s(formData, 'name');
  const headline = s(formData, 'headline');
  if (!name || !headline) return;
  const body = s(formData, 'body');
  const ctaLabel = s(formData, 'cta_label');
  const ctaHref = s(formData, 'cta_href');
  if (headline.length > HEADLINE_MAX || (body?.length ?? 0) > BODY_MAX || (ctaLabel?.length ?? 0) > CTA_LABEL_MAX) {
    refuseInput(`Keep the headline to ${HEADLINE_MAX}, the body to ${BODY_MAX} and the button label to ${CTA_LABEL_MAX} characters.`);
  }
  if (ctaHref && safeHref(ctaHref) !== ctaHref) refuseInput('The button link must be a path on this site (/signup) or an http(s) URL.');

  const trigger = normalizeTrigger({
    mode: s(formData, 'mode'),
    delayMs: Number(s(formData, 'delayMs') ?? '0'),
    scrollPercent: Number(s(formData, 'scrollPercent') ?? '60'),
  });
  const priority = Number(s(formData, 'priority') ?? '0');

  const { data, error } = await supabase.from('marketing_exit_intent').insert({
    name,
    headline,
    body,
    cta_label: ctaLabel,
    cta_href: ctaHref,
    match: buildMatch(formData) as unknown as Json,
    trigger_config: trigger as unknown as Json,
    priority: Number.isFinite(priority) ? Math.round(priority) : 0,
    // Live to every public visitor is a deliberate choice, not the default.
    status: s(formData, 'status') === 'active' ? 'active' : 'paused',
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the exit-intent offer', error ?? new Error('The exit-intent offer row was not returned after save.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_exit_intent', resourceId: data.id, metadata: { name } });
  revalidatePath('/admin/marketing/exit-intent');
}

export async function toggleExitIntentAction(id: string, activate: boolean): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('marketing_exit_intent').update({ status: activate ? 'active' : 'paused' })
    .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the exit-intent offer', error ?? new Error('Exit-intent offer not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_exit_intent', resourceId: id, metadata: { status: activate ? 'active' : 'paused' } });
  revalidatePath('/admin/marketing/exit-intent');
}

export async function deleteExitIntentAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('marketing_exit_intent').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the exit-intent offer', error ?? new Error('Exit-intent offer not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_exit_intent', resourceId: id });
  revalidatePath('/admin/marketing/exit-intent');
}
