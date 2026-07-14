'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { SURVEY_TYPES, isSurveyType, generateSlug } from '@/lib/marketing/surveys';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function n(fd: FormData, k: string, fallback: number): number {
  const v = Number(fd.get(k));
  return Number.isFinite(v) ? v : fallback;
}

export async function createSurveyAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const typeRaw = String(formData.get('type') ?? 'nps');
  const type = isSurveyType(typeRaw) ? typeRaw : 'nps';
  const cfg = SURVEY_TYPES[type];
  const name = s(formData, 'name') ?? `${cfg.label} survey`;
  const slug = generateSlug(name);

  const { data, error } = await supabase
    .from('surveys')
    .insert({
      slug,
      name,
      type,
      question: s(formData, 'question') ?? cfg.defaultQuestion,
      scale_min: n(formData, 'scale_min', cfg.scaleMin),
      scale_max: n(formData, 'scale_max', cfg.scaleMax),
      low_label: s(formData, 'low_label') ?? cfg.lowLabel,
      high_label: s(formData, 'high_label') ?? cfg.highLabel,
      follow_up_question: s(formData, 'follow_up_question') ?? 'What’s the main reason for your score?',
      thank_you_message: s(formData, 'thank_you_message') ?? 'Thanks for your feedback!',
      audience: s(formData, 'audience'),
      status: 'draft',
      created_by: actorId,
    })
    .select('id')
    .single();

  if (error || !data) marketingActionFailure('create the survey', error ?? new Error('No survey was created'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'survey', resourceId: data.id, metadata: { type, name } });
  revalidatePath('/admin/marketing/surveys');
  redirect(`/admin/marketing/surveys/${data.id}`);
}

export async function setSurveyStatusAction(id: string, status: 'draft' | 'active' | 'closed') {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { error } = await supabase.from('surveys').update({ status }).eq('id', id);
  if (error) marketingActionFailure('update the survey status', error);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'survey', resourceId: id, metadata: { status } });
  revalidatePath('/admin/marketing/surveys');
  revalidatePath(`/admin/marketing/surveys/${id}`);
}

export async function deleteSurveyAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { error } = await supabase.from('surveys').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) marketingActionFailure('delete the survey', error);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'survey', resourceId: id });
  revalidatePath('/admin/marketing/surveys');
  redirect('/admin/marketing/surveys');
}
