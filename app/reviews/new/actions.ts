'use server';

import { createHash, randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { signedInUserId } from '@/lib/auth/signed-in-user';
import { clientIp } from '@/lib/server/rate-limit';
import { rateLimitDbVerdict } from '@/lib/server/rate-limit-db';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

/** Reviews one address may submit in a day: a person writes one. */
const REVIEWS_PER_IP_PER_DAY = 3;
const DAY_MS = 86_400_000;
/** The key under which a review's text fingerprint travels in `reviews.metadata`. */
const TEXT_FINGERPRINT = 'text_fingerprint';
const ADMISSION_MARKER = 'submission_admission';
const ADMITTED = 'v1:admitted';

type ReviewWitness = { id?: unknown; metadata?: unknown; deleted_at?: unknown; status?: unknown };
function admissionMarker(row: ReviewWitness): unknown {
  return row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)[ADMISSION_MARKER] : null;
}
function liveAdmitted(row: ReviewWitness | null | undefined, id?: string): boolean {
  return Boolean(row && typeof row.id === 'string' && (!id || row.id === id)
    && row.deleted_at === null && admissionMarker(row) === ADMITTED);
}

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
 *
 * New submissions are hidden with a versioned ownership hold until their
 * text admission and required activation are confirmed. A repeat receipt
 * requires a live admitted row; a spent limiter counter alone is not a review.
 * Cleanup can remove only this attempt's exact provisional hold. Existing
 * public/admin lists already exclude non-null deleted_at rows.
 *
 * This is a current-writer lifecycle protocol, not a rolling-upgrade repair
 * for old unversioned in-flight writers. Failed activation can leave a spent
 * text counter with no live row; retries must report that honestly rather
 * than infer success. No native database uniqueness claim is made.
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
  const fingerprint = title || body ? createHash('sha256').update(JSON.stringify([title, body])).digest('hex') : null;
  const since = new Date(Date.now() - DAY_MS).toISOString();
  // Neither provisional holds nor unversioned rows establish a new-protocol
  // receipt. Old writers require a separately qualified release cutover.
  async function admittedRepeat() {
    return supabase.from('reviews').select('id,metadata,deleted_at')
      .eq(`metadata->>${TEXT_FINGERPRINT}`, fingerprint!)
      .eq(`metadata->>${ADMISSION_MARKER}`, ADMITTED)
      .is('deleted_at', null).gte('created_at', since).order('id').limit(1);
  }
  if (fingerprint) {
    const repeat = await admittedRepeat();
    if (repeat.error) return { ok: false, error: t('actions.couldNotSaveYourReview') };
    if (repeat.data?.some(row => liveAdmitted(row))) return { ok: true };
  }

  const { data: settings } = await supabase
    .from('reputation_settings').select('auto_approve_min').eq('singleton', true).maybeSingle();
  const autoMin = settings?.auto_approve_min ?? null;
  // Only a signed-in member's review can clear the threshold; a stranger's is
  // moderated whatever its rating. Null is "not signed in", never a refusal.
  const authorId = await signedInUserId();
  const publish = authorId !== null && autoMin != null && rating >= autoMin;

  const id = randomUUID();
  const heldAt = new Date().toISOString();
  const hold = 'v1:staged:' + randomUUID();
  const metadata = { ...(fingerprint ? { [TEXT_FINGERPRINT]: fingerprint } : {}), [ADMISSION_MARKER]: hold };
  // deleted_at is a visibility hold, not a user deletion. It is cleared only
  // by the exact owner after admission, so existing readers cannot publish it.
  const written = await supabase.from('reviews').insert({
    id, rating, title, body,
    author_name: typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) || null : null,
    author_email: typeof payload.email === 'string' ? payload.email.trim().slice(0, 200) || null : null,
    source: 'internal', status: 'pending', deleted_at: heldAt, metadata,
  }).select('id,metadata,deleted_at,status');
  const staged = written.data?.length === 1 ? written.data[0] : null;
  if (written.error || !staged || staged.id !== id || typeof staged.deleted_at !== 'string'
    || Date.parse(staged.deleted_at) !== Date.parse(heldAt)
    || staged.status !== 'pending' || admissionMarker(staged) !== hold) {
    return { ok: false, error: t('actions.couldNotSaveYourReview') };
  }

  async function removeOwnStage() {
    const removed = await supabase.from('reviews').delete().eq('id', id)
      .eq('deleted_at', heldAt).eq(`metadata->>${ADMISSION_MARKER}`, hold)
      .eq('status', 'pending').select('id');
    return !removed.error && removed.data?.length === 1 && removed.data[0].id === id;
  }

  if (fingerprint) {
    const admission = await rateLimitDbVerdict(supabase, `review:text:${fingerprint}`, { limit: 1, windowMs: DAY_MS });
    if (admission.verdict !== 'allowed') {
      const gone = await removeOwnStage();
      if (!gone) console.error('[reviews] provisional cleanup was not confirmed; no admitted row is removed', { id });
      if (admission.verdict === 'refused') {
        // A concurrent winner may still be activating. Bounded real reads can
        // establish a receipt; neither elapsed time nor the counter can.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 25));
          const winner = await admittedRepeat();
          if (winner.error) break;
          if (winner.data?.some(row => liveAdmitted(row))) return { ok: true };
        }
      }
      return { ok: false, error: t('actions.couldNotSaveYourReview') };
    }
  }

  const activated = await supabase.from('reviews').update({
    deleted_at: null, metadata: { ...metadata, [ADMISSION_MARKER]: ADMITTED },
  }).eq('id', id).eq('deleted_at', heldAt).eq(`metadata->>${ADMISSION_MARKER}`, hold)
    .eq('status', 'pending').select('id,metadata,deleted_at').maybeSingle();
  let confirmed = !activated.error && liveAdmitted(activated.data, id);
  if (!confirmed) {
    // The write may have committed despite a missing answer. Read the actual
    // same owned row before acknowledging; never compensate by deleting it.
    const witness = await supabase.from('reviews').select('id,metadata,deleted_at')
      .eq('id', id).eq(`metadata->>${ADMISSION_MARKER}`, ADMITTED)
      .is('deleted_at', null).maybeSingle();
    confirmed = !witness.error && liveAdmitted(witness.data, id);
  }
  if (!confirmed) {
    await removeOwnStage();
    console.error('[reviews] required activation was not confirmed', { id });
    return { ok: false, error: t('quickCapture.saveUncertain') };
  }

  if (publish) {
    const promoted = await supabase.from('reviews').update({ status: 'approved' })
      .eq('id', id).eq('status', 'pending').select('id');
    // Written and admitted, so the person is told it was received; it waits
    // for moderation instead of being published.
    if (promoted.error || promoted.data?.length !== 1) {
      console.error('[reviews] an auto-approved review could not be published; it stays pending', { id, code: promoted.error?.code ?? null });
    }
  }
  return { ok: true };
}
