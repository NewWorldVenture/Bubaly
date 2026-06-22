'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import type { ABVariant } from '@/lib/marketing/ab';
import type { Database } from '@/lib/database.types';

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export async function createExperiment(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const name = String(formData.get('name') || '').trim();
  if (!name) return { ok: false, error: 'Name is required' };
  const hypothesis = String(formData.get('hypothesis') || '').trim() || null;
  const metric = String(formData.get('metric') || 'conversion').trim() || 'conversion';

  // Variant labels come in as a newline/comma list; control is always first.
  const rawVariants = String(formData.get('variants') || 'Control\nVariant B');
  const labels = rawVariants.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const variants: ABVariant[] = labels.map((label) => {
    let key = slugify(label) || 'v';
    while (seen.has(key)) key += '-x';
    seen.add(key);
    return { key, label };
  });
  if (variants.length < 2) return { ok: false, error: 'Add at least two variants' };

  const key = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await supabase.from('ab_experiments').insert({
    key, name, hypothesis, metric,
    variants: variants as unknown as Database['public']['Tables']['ab_experiments']['Insert']['variants'],
    created_by: actorId,
  });
  if (error) return { ok: false, error: error.message };
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'ab_experiment', metadata: { key, name } });
  revalidatePath('/admin/marketing/experiments');
  return { ok: true };
}

export async function setExperimentStatus(id: string, status: 'draft' | 'running' | 'paused' | 'completed') {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { error } = await supabase.from('ab_experiments').update({ status, updated_by: actorId }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'ab_experiment', resourceId: id, metadata: { status } });
  revalidatePath('/admin/marketing/experiments');
  return { ok: true };
}

export async function setExperimentWinner(id: string, winner: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { error } = await supabase.from('ab_experiments').update({ winner, status: 'completed', updated_by: actorId }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'ab_experiment', resourceId: id, metadata: { winner } });
  revalidatePath('/admin/marketing/experiments');
  return { ok: true };
}
