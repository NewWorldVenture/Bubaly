'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import type { AudienceMatch, PersonalizationVariant } from '@/lib/marketing/personalization';
import type { Json } from '@/lib/database.types';

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
  const minSessions = Number(s(fd, 'minSessions') ?? '');
  if (Number.isFinite(minSessions) && minSessions > 0) m.minSessions = Math.round(minSessions);
  return m;
}

function buildVariant(fd: FormData): PersonalizationVariant {
  const v: PersonalizationVariant = {};
  for (const k of ['headline', 'subhead', 'body', 'cta_label', 'cta_href'] as const) {
    const val = s(fd, k);
    if (val) v[k] = val;
  }
  return v;
}

export async function createRuleAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = s(formData, 'name');
  const slot = s(formData, 'slot');
  if (!name || !slot) return;

  const priority = Number(s(formData, 'priority') ?? '0');
  const { data } = await supabase.from('marketing_personalization_rules').insert({
    name,
    slot,
    match: buildMatch(formData) as unknown as Json,
    variant: buildVariant(formData) as unknown as Json,
    priority: Number.isFinite(priority) ? Math.round(priority) : 0,
    status: s(formData, 'status') === 'paused' ? 'paused' : 'active',
    created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_personalization_rule', resourceId: data?.id ?? null, metadata: { name, slot } });
  revalidatePath('/admin/marketing/personalization');
}

export async function toggleRuleStatusAction(id: string, activate: boolean): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('marketing_personalization_rules').update({ status: activate ? 'active' : 'paused' }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_personalization_rule', resourceId: id, metadata: { status: activate ? 'active' : 'paused' } });
  revalidatePath('/admin/marketing/personalization');
}

export async function deleteRuleAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('marketing_personalization_rules').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_personalization_rule', resourceId: id });
  revalidatePath('/admin/marketing/personalization');
}
