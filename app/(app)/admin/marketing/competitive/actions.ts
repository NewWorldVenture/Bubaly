'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { normalizeDomain, clampScore, isBacklinkStatus } from '@/lib/marketing/competitive';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function int(fd: FormData, k: string): number | null {
  const v = s(fd, k);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Competitors ────────────────────────────────────────────────────────────
export async function saveCompetitorAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = s(formData, 'name');
  if (!name) return;
  const row = { name, domain: normalizeDomain(s(formData, 'domain')) || null, ranking: int(formData, 'ranking'), notes: s(formData, 'notes') };
  const { data, error } = await supabase.from('competitors').insert({ ...row, created_by: actorId }).select('id').single();
  if (error || !data) marketingActionFailure('create the competitor', error ?? new Error('No competitor was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'competitor', resourceId: data.id });
  revalidatePath('/admin/marketing/competitive');
}

export async function deleteCompetitorAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('competitors').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the competitor', error ?? new Error('Competitor not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'competitor', resourceId: id });
  revalidatePath('/admin/marketing/competitive');
}

// ── Keywords ───────────────────────────────────────────────────────────────
export async function saveKeywordAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const keyword = s(formData, 'keyword');
  if (!keyword) return;
  const row = {
    keyword,
    search_volume: int(formData, 'search_volume') ?? 0,
    difficulty: clampScore(int(formData, 'difficulty')),
    our_rank: int(formData, 'our_rank'),
  };
  const { data, error } = await supabase.from('keyword_intel').insert({ ...row, created_by: actorId }).select('id').single();
  if (error || !data) marketingActionFailure('create the keyword record', error ?? new Error('No keyword record was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'keyword_intel', resourceId: data.id });
  revalidatePath('/admin/marketing/competitive');
}

export async function deleteKeywordAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('keyword_intel').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the keyword record', error ?? new Error('Keyword record not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'keyword_intel', resourceId: id });
  revalidatePath('/admin/marketing/competitive');
}

// ── Backlinks ──────────────────────────────────────────────────────────────
export async function saveBacklinkAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const source = normalizeDomain(s(formData, 'source_domain'));
  if (!source) return;
  const status = s(formData, 'status') ?? 'active';
  const row = {
    source_domain: source,
    target_url: s(formData, 'target_url'),
    authority: clampScore(int(formData, 'authority')),
    status: isBacklinkStatus(status) ? status : 'active',
  };
  const { data, error } = await supabase.from('backlinks').insert({ ...row, created_by: actorId }).select('id').single();
  if (error || !data) marketingActionFailure('create the backlink', error ?? new Error('No backlink was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'backlink', resourceId: data.id });
  revalidatePath('/admin/marketing/competitive');
}

export async function deleteBacklinkAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('backlinks').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the backlink', error ?? new Error('Backlink not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'backlink', resourceId: id });
  revalidatePath('/admin/marketing/competitive');
}
