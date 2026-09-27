'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { superAdminGate } from '@/lib/auth/super-admin-gate';
import { createServiceClient } from '@/lib/supabase/server';
import { SOCIAL_PLATFORMS, type SocialLinks } from '@/lib/marketing/social-links';
import {
  setSocialLinks,
  socialLinksRevision,
  SocialLinksConflictError,
  SOCIAL_LINKS_TAG,
} from '@/lib/server/social-links';
import { describeActionError } from '@/lib/supabase/errors';

export type SaveSocialLinksResult =
  | { ok: true; saved: SocialLinks; rejected: string[]; revision: string }
  // `mustReload`: the form this came from can never save — it was built on a
  // value that is no longer stored, or it did not say what it was built on — so
  // the same click will be refused every time until the page is loaded again.
  // A transient failure (the database did not answer) leaves it unset: the same
  // form may save on the next try.
  | { ok: false; error: string; mustReload?: true };

/**
 * Replaces the published social profile links.
 *
 * Reports which fields were dropped rather than saving silently: an admin who
 * pastes "facebook.com/bubaly" without the scheme should be told it did not
 * take, not left believing the footer now has a Facebook link.
 *
 * The write is a compare-and-set against `revision`, the fingerprint the page
 * rendered from. Six blank fields are a legitimate submission — clearing every
 * field is how an admin removes every icon — so the blanks themselves cannot be
 * rejected. What is rejected is blanks over a row this form was never shown,
 * which is what a failed read at render time (or a stale tab) produces, and
 * which used to wipe all six URLs and report "Social links updated".
 */
export async function saveSocialLinksAction(formData: FormData): Promise<SaveSocialLinksResult> {
  const t = await getTranslations();
  const gate = await superAdminGate();
  if (gate.status !== 'allowed') {
    return { ok: false, error: gate.status === 'unavailable' ? t('ai.accountContextIsTemporarilyUnavailable') : t('actions.forbidden') };
  }
  const { user } = gate;

  const expectedRevision = String(formData.get('revision') ?? '').trim();
  if (!expectedRevision) {
    return { ok: false, error: t('actions.socialLinksFormDidNotSayWhatItLoaded'), mustReload: true };
  }

  const submitted: SocialLinks = {};
  const nonEmpty: string[] = [];
  for (const { key } of SOCIAL_PLATFORMS) {
    const raw = String(formData.get(key) ?? '').trim();
    if (!raw) continue;
    nonEmpty.push(key);
    submitted[key] = raw;
  }

  try {
    const saved = await setSocialLinks(createServiceClient(), submitted, user.id, expectedRevision);
    const rejected = nonEmpty.filter((k) => !saved[k as keyof SocialLinks]);
    // The footer's read is cached under this tag (it renders on every public
    // page, so it must not hit Postgres per view). Dropping the tag is what
    // keeps an admin edit immediate despite that cache.
    revalidateTag(SOCIAL_LINKS_TAG, { expire: 0 });
    revalidatePath('/admin/settings/social-links');
    // The footer renders on every marketing route, so the whole tree is stale.
    revalidatePath('/', 'layout');
    return { ok: true, saved, rejected, revision: socialLinksRevision(saved) };
  } catch (e) {
    console.error('[admin-social-links] save failed', e);
    // A conflict is not a database fault and must not be described as one: the
    // row is intact, the submission was built on something else, and the remedy
    // is to reload and look at what is actually stored before replacing it.
    if (e instanceof SocialLinksConflictError) {
      return { ok: false, error: t('actions.socialLinksChangedSinceThisPageLoaded'), mustReload: true };
    }
    return { ok: false, error: describeActionError(e, t('actions.couldNotSaveSocialLinks')) };
  }
}
