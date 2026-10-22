'use server';

import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { signedInUserId } from '@/lib/auth/signed-in-user';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

/** Reviews one address may submit in a day: a person writes one. */
const REVIEWS_PER_IP_PER_DAY = 3;
const DAY_MS = 86_400_000;

/**
 * Public review submission — NO auth. Writes via the service-role client (reviews
 * are RLS-locked to it).
 *
 * A stranger's review is always PENDING. The configured auto-approve threshold
 * (reputation_settings.auto_approve_min) publishes a review straight to the
 * public /reviews wall, and it used to apply to anyone: behind the 5/min limiter
 * one address could post 7,200 approved five-star reviews a day under invented
 * names, and rotating addresses removed even that bound. The threshold now
 * applies only to a signed-in Bubaly user; everyone else waits for moderation.
 * Beside it: a per-address daily budget, a honeypot field answered exactly like
 * a success that writes nothing, and repeated text within a day dropped
 * silently. Audit N4.
 */
export async function submitReviewAction(input: {
  rating: number;
  title?: string;
  body?: string;
  name?: string;
  email?: string;
  /** Honeypot: hidden from people, filled by bots. Anything in it is a silent no-op. */
  website?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const supabase = createServiceClient();
  const ip = clientIp(await headers());
  const limited = await enforceRequestRateLimit(supabase, `review:${ip}`, { limit: 5 });
  if (!limited.ok) return { ok: false, error: t('actions.tooManyReviewAttemptsPlease') };
  const daily = await enforceRequestRateLimit(supabase, `review:day:${ip}`, { limit: REVIEWS_PER_IP_PER_DAY, windowMs: DAY_MS });
  if (!daily.ok) return { ok: false, error: t('actions.tooManyReviewAttemptsPlease') };

  const rating = Math.round(Number(payload.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: t('actions.pleaseChooseAStarRating') };
  }
  // A bot that fills every field fills this one. It is told what a person is
  // told, and nothing is written.
  if (typeof payload.website === 'string' && payload.website.trim()) return { ok: true };

  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 160) || null : null;
  const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 4000) || null : null;
  // The same words twice in a day are one review, whoever posts them.
  if (title || body) {
    const fingerprint = createHash('sha256').update(JSON.stringify([title, body])).digest('hex');
    const repeat = await enforceRequestRateLimit(supabase, `review:text:${fingerprint}`, { limit: 1, windowMs: DAY_MS });
    if (!repeat.ok) return { ok: true };
  }

  const { data: settings } = await supabase
    .from('reputation_settings').select('auto_approve_min').eq('singleton', true).maybeSingle();
  const autoMin = settings?.auto_approve_min ?? null;
  // Only a signed-in member's review can clear the threshold; a stranger's is
  // moderated whatever its rating. Null is "not signed in", never a refusal.
  const authorId = await signedInUserId();
  const status = authorId !== null && autoMin != null && rating >= autoMin ? 'approved' : 'pending';

  const { error } = await supabase.from('reviews').insert({
    rating,
    title,
    body,
    author_name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) || null : null,
    author_email: typeof payload.email === 'string' ? payload.email.trim().slice(0, 200) || null : null,
    source: 'internal',
    status,
  });
  if (error) return { ok: false, error: t('actions.couldNotSaveYourReview') };
  return { ok: true };
}
