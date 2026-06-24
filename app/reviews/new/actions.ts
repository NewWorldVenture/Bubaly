'use server';

import { createServiceClient } from '@/lib/supabase/server';

/**
 * Public review submission — NO auth. Writes via the service-role client (reviews
 * are RLS-locked to it). Auto-approves at/above the configured threshold, else
 * leaves the review pending for moderation.
 */
export async function submitReviewAction(input: {
  rating: number;
  title?: string;
  body?: string;
  name?: string;
  email?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const rating = Math.round(Number(input.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'Please choose a star rating.' };
  }
  const supabase = createServiceClient();
  const { data: settings } = await supabase
    .from('reputation_settings').select('auto_approve_min').eq('singleton', true).maybeSingle();

  const autoMin = settings?.auto_approve_min ?? null;
  const status = autoMin != null && rating >= autoMin ? 'approved' : 'pending';

  const { error } = await supabase.from('reviews').insert({
    rating,
    title: input.title?.trim()?.slice(0, 160) || null,
    body: input.body?.trim()?.slice(0, 4000) || null,
    author_name: input.name?.trim()?.slice(0, 120) || null,
    author_email: input.email?.trim()?.slice(0, 200) || null,
    source: 'internal',
    status,
  });
  if (error) return { ok: false, error: 'Could not save your review. Please try again.' };
  return { ok: true };
}
