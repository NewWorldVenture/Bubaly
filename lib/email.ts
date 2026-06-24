import type { ReactElement } from 'react';
import { Resend } from 'resend';

let resendClient: Resend | null = null;

export function getResend(): Resend {
  resendClient ??= new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/** True when a Resend API key is configured (set RESEND_API_KEY in the env). */
export const emailEnabled = (): boolean => Boolean(process.env.RESEND_API_KEY);

/**
 * Sender address. Override with EMAIL_FROM in the environment and point it at a
 * domain you've verified in Resend (https://resend.com/domains). Until a domain
 * is verified, Resend only allows the shared `onboarding@resend.dev` sender, so
 * that's the safe default.
 */
export const FROM_EMAIL =
  process.env.EMAIL_FROM ?? 'Bubaly <onboarding@resend.dev>';

/** Public base URL used to build links inside emails. */
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://www.bubaly.com';

type SendReactArgs = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
};

/**
 * Sends a React-rendered email via Resend. Centralizes the from-address and,
 * crucially, surfaces failures: the Resend SDK resolves (it does NOT throw) on
 * API errors such as an unverified domain, so callers must inspect `error`.
 * No-ops with a log when no API key is set, so local/dev flows never break.
 */
export async function sendReactEmail({
  to,
  subject,
  react,
  replyTo,
}: SendReactArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }

  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to,
    subject,
    react,
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    console.error('[email failed]', error);
    return { ok: false };
  }
  return { ok: true };
}
