'use server';

import { headers } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

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
  const t = await getTranslations();
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `review:${clientIp(await headers())}`, { limit: 5 });
  if (!limited.ok) return { ok: false, error: t('actions.tooManyReviewAttemptsPlease') };

  const rating = Math.round(Number(payload.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: t('actions.pleaseChooseAStarRating') };
  }
  const { data: settings } = await supabase
    .from('reputation_settings').select('auto_approve_min').eq('singleton', true).maybeSingle();

  const autoMin = settings?.auto_approve_min ?? null;
  const status = autoMin != null && rating >= autoMin ? 'approved' : 'pending';

  const { error } = await supabase.from('reviews').insert({
    rating,
    title: typeof payload.title === 'string' ? payload.title.trim().slice(0, 160) || null : null,
    body: typeof payload.body === 'string' ? payload.body.trim().slice(0, 4000) || null : null,
    author_name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) || null : null,
    author_email: typeof payload.email === 'string' ? payload.email.trim().slice(0, 200) || null : null,
    source: 'internal',
    status,
  });
  if (error) return { ok: false, error: t('actions.couldNotSaveYourReview') };
  return { ok: true };
}
