'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { SOCIAL_PLATFORMS, type SocialLinks } from '@/lib/marketing/social-links';
import { setSocialLinks } from '@/lib/server/social-links';
import { describeActionError } from '@/lib/supabase/errors';

export type SaveSocialLinksResult =
  | { ok: true; saved: SocialLinks; rejected: string[] }
  | { ok: false; error: string };

/**
 * Replaces the published social profile links.
 *
 * Reports which fields were dropped rather than saving silently: an admin who
 * pastes "facebook.com/bubaly" without the scheme should be told it did not
 * take, not left believing the footer now has a Facebook link.
 */
export async function saveSocialLinksAction(formData: FormData): Promise<SaveSocialLinksResult> {
  const t = await getTranslations();
  const user = await getUser();
  if (!user || !(await isSuperAdmin())) return { ok: false, error: t('actions.forbidden') };

  const submitted: SocialLinks = {};
  const nonEmpty: string[] = [];
  for (const { key } of SOCIAL_PLATFORMS) {
    const raw = String(formData.get(key) ?? '').trim();
    if (!raw) continue;
    nonEmpty.push(key);
    submitted[key] = raw;
  }

  try {
    const saved = await setSocialLinks(createServiceClient(), submitted, user.id);
    const rejected = nonEmpty.filter((k) => !saved[k as keyof SocialLinks]);
    revalidatePath('/admin/settings/social-links');
    // The footer renders on every marketing route, so the whole tree is stale.
    revalidatePath('/', 'layout');
    return { ok: true, saved, rejected };
  } catch (e) {
    console.error('[admin-social-links] save failed', e);
    return { ok: false, error: describeActionError(e, t('actions.couldNotSaveSocialLinks')) };
  }
}
