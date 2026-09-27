'use server';

import { revalidatePath } from 'next/cache';
import * as React from 'react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { APP_URL, sendReactEmail } from '@/lib/email';
import { ReferralEmail } from '@/lib/emails/referral';
import { emailSchema } from '@/lib/validation';
import {
  applyReferralCode, getOrCreateReferralCode, getReferralConfig,
  recordReferralEmailInvite, rollbackReferralEmailInvite, type ApplyFailureCode, type ApplyResult,
} from '@/lib/referrals/server';
import { REFERRAL_EMAIL_POLICY, REFERRAL_HOME_CARD_DISMISSED_KEY, referralLink } from '@/lib/referrals/core';
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';

/**
 * The catalogue key for each way applying a code can fail. `applyReferralCode`
 * lives in lib/, where there is no translator, so it answers with a machine
 * code and an English fallback; the wording the family reads is chosen here.
 */
const APPLY_FAILURE_KEY: Record<ApplyFailureCode, string> = {
  empty: 'referralActions.enterAReferralCode',
  paused: 'referralActions.programPaused',
  not_found: 'referralActions.codeNotFound',
  own_code: 'referralActions.cannotUseYourOwnCode',
  already_referred: 'referralActions.familyAlreadyUsedACode',
  lookup_failed: 'referralActions.couldNotApplyCode',
  write_failed: 'referralActions.couldNotApplyCode',
};

export async function applyReferralCodeAction(rawCode: string): Promise<ApplyResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const result = await applyReferralCode({
    rawCode,
    referredFamilyId: ctx.active.familyId,
    referredEmail: ctx.user.email,
    source: 'apply_code',
  });
  if (result.ok) {
    revalidatePath('/referrals');
    return result;
  }
  return { ...result, reason: t(APPLY_FAILURE_KEY[result.code]) };
}

export type SendReferralEmailResult = { ok: true; email: string } | { ok: false; reason: string };

/**
 * Email a friend the family's referral code and link. Goes out through the
 * same Resend transport and From address as the member InviteEmail. Limited
 * to REFERRAL_EMAIL_POLICY.limit sends per family per day, counted from the
 * send timestamps persisted on the referrals rows themselves.
 */
export async function sendReferralEmailAction(rawEmail: string): Promise<SendReferralEmailResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const parsed = emailSchema.safeParse(typeof rawEmail === 'string' ? rawEmail : '');
  if (!parsed.success) return { ok: false, reason: t('referralActions.enterAValidEmail') };
  const email = parsed.data;
  if (ctx.user.email && email === ctx.user.email.trim().toLowerCase()) {
    return { ok: false, reason: t('referralActions.youCanTInviteYourself') };
  }

  const service = createServiceClient();
  const config = await getReferralConfig(service);
  if (!config.enabled) return { ok: false, reason: t('referralActions.programPaused') };

  const familyId = ctx.active.familyId;
  const code = await getOrCreateReferralCode(familyId, { familyName: ctx.active.family.name, userId: ctx.user.id });
  const sentAt = new Date();
  const record = await recordReferralEmailInvite(service, { referrerFamilyId: familyId, code, email, config, now: sentAt });
  if (!record.ok) {
    if (record.reason === 'throttled') return { ok: false, reason: t('referralActions.dailyEmailLimitReached', { limit: REFERRAL_EMAIL_POLICY.limit }) };
    return { ok: false, reason: t('referralActions.couldNotRecordInvite') };
  }

  const inviterName = ctx.active.member.display_name;
  const familyName = ctx.active.family.name;
  const { ok, skipped } = await sendReactEmail({
    to: email,
    subject: `${inviterName} sent you their Bubaly referral code`,
    react: React.createElement(ReferralEmail, {
      inviterName,
      familyName,
      code,
      // Same origin the member InviteEmail links to, so a preview deploy
      // does not mail people a link back to production.
      link: referralLink(code, APP_URL),
      rewardLabel: config.rewardLabel,
    }),
  });
  // `skipped` is no mail provider configured: nothing was sent, so the invite
  // record (and the daily limit it counts toward) is rolled back as for a
  // failed send.
  if (!ok || skipped) {
    await rollbackReferralEmailInvite(service, { rowId: record.rowId, created: record.created, sentAt });
    return { ok: false, reason: t('referralActions.couldNotSendEmail') };
  }

  revalidatePath('/referrals');
  return { ok: true, email };
}

/** The user's own preferences row carries the dismissal, merged into notification_prefs (own-row RLS). */
export async function dismissReferralHomeCardAction(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // Only the dismissal key changes, with a compare-and-set (SRV-001 l7).
  const dismissedAt = new Date().toISOString();
  const saved = await mergeNotificationPrefs(supabase, ctx.user.id,
    (prefs) => ({ ...prefs, [REFERRAL_HOME_CARD_DISMISSED_KEY]: dismissedAt }));
  if (!saved.ok) {
    if (saved.reason === 'read_failed') console.error('[referrals/home-card] preferences read failed', saved.error);
    else console.error('[referrals/home-card] preferences write failed', saved.error ?? saved.reason);
    return { ok: false, reason: t('referralActions.couldNotSaveYourPreference') };
  }
  revalidatePath('/home');
  return { ok: true };
}
