'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { slugify, clampRating } from '@/lib/marketing/reputation';
import { CASE_STUDIES_CACHE_TAG } from '@/lib/marketing/case-study';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

// ── Testimonials ───────────────────────────────────────────────────────────
export async function saveTestimonialAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const author_name = s(formData, 'author_name');
  const quote = s(formData, 'quote');
  if (!author_name || !quote) return;

  const row = {
    author_name,
    author_role: s(formData, 'author_role'),
    company: s(formData, 'company'),
    quote,
    rating: clampRating(Number(s(formData, 'rating') ?? '')),
    is_published: formData.get('is_published') === 'on',
  };

  if (id) {
    const { data, error } = await supabase.from('testimonials').update(row).eq('id', id).select('id').maybeSingle();
    if (error || !data) marketingActionFailure('update the testimonial', error ?? new Error('Testimonial not found.'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'testimonial', resourceId: id });
  } else {
    const { data, error } = await supabase.from('testimonials').insert({ ...row, created_by: actorId }).select('id').single();
    if (error || !data) marketingActionFailure('create the testimonial', error ?? new Error('The testimonial row was not returned after save.'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'testimonial', resourceId: data.id });
  }
  revalidatePath('/admin/marketing/reputation');
}

export async function togglePublishTestimonialAction(id: string, publish: boolean) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('testimonials').update({ is_published: publish }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('publish the testimonial', error ?? new Error('Testimonial not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'testimonial', resourceId: id, metadata: { is_published: publish } });
  revalidatePath('/admin/marketing/reputation');
}

export async function deleteTestimonialAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('testimonials').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the testimonial', error ?? new Error('Testimonial not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'testimonial', resourceId: id });
  revalidatePath('/admin/marketing/reputation');
}

// ── Case studies ───────────────────────────────────────────────────────────
export async function saveCaseStudyAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const title = s(formData, 'title');
  if (!title) return;

  const row = {
    title,
    slug: s(formData, 'slug') ? slugify(s(formData, 'slug')!) : slugify(title),
    industry: s(formData, 'industry'),
    customer_name: s(formData, 'customer_name'),
    summary: s(formData, 'summary'),
    ...(formData.has('body') ? { body: s(formData, 'body') } : {}),
    result_metric: s(formData, 'result_metric'),
    is_published: formData.get('is_published') === 'on',
  };

  if (id) {
    const { data, error } = await supabase.from('case_studies').update(row).eq('id', id).select('id').maybeSingle();
    if (error || !data) marketingActionFailure('update the case study', error ?? new Error('Case study not found.'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'case_study', resourceId: id });
  } else {
    const { data, error } = await supabase.from('case_studies').insert({ ...row, created_by: actorId }).select('id').single();
    if (error || !data) marketingActionFailure('create the case study', error ?? new Error('The case study row was not returned after save.'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'case_study', resourceId: data.id });
  }
  revalidateTag(CASE_STUDIES_CACHE_TAG);
  revalidatePath('/admin/marketing/reputation');
}

export async function deleteCaseStudyAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('case_studies').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the case study', error ?? new Error('Case study not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'case_study', resourceId: id });
  revalidateTag(CASE_STUDIES_CACHE_TAG);
  revalidatePath('/admin/marketing/reputation');
}
