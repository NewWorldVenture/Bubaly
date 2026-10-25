import type { ReactElement } from 'react';
import { Resend } from 'resend';
import { appBaseUrl } from '@/lib/server/app-url';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';
import { withEmailDeadline } from '@/lib/email-deadline';

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

/**
 * Public base URL used to build links inside emails.
 *
 * The SITE_URL step is this module's own precedence and stays; what changed is
 * what happens to the value once chosen. It was interpolated raw, so a
 * NEXT_PUBLIC_APP_URL ending in `/` put `https://host//dashboard` into every
 * link in every email. Harmless where a browser is doing the resolving, unlike
 * the same slash on the Twilio signature path — but there is no reason to
 * normalise in one place and not the other. See lib/server/app-url.ts.
 */
export const APP_URL = appBaseUrl(
  process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
);

/** Whether any recipient is a kid login's synthetic, never-delivered address. */
export function addressesAKidLogin(to: string | string[]): boolean {
  return (Array.isArray(to) ? to : [to]).some((address) => isChildLoginEmail(address));
}

type SendReactArgs = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string;
  idempotencyKey?: string;
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
  idempotencyKey,
}: SendReactArgs): Promise<{ ok: boolean; skipped?: boolean }> {
  // Never to a kid login's synthetic address (lib/onboarding/child-login.ts):
  // nothing is ever delivered there and the domain is not Bubaly's, so a send
  // is either a bounce against the sender's reputation or a child's data in a
  // stranger's inbox. Refused before the provider is asked, and reported as
  // not sent.
  if (addressesAKidLogin(to)) {
    console.error('[email refused — a kid login address is never mailed]', { subject });
    return { ok: false };
  }
  if (!emailEnabled()) {
    console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: true, skipped: true };
  }

  // The SDK reports a REJECTED address through `{ error }`, but it can also
  // THROW — a network failure, or a malformed API key, which surfaces from
  // inside the client as a bare TypeError. This function's whole contract is
  // that it answers `{ ok }`, and every caller is built on that: the weekly
  // digest counts failures per family and moves on, onboarding logs and
  // continues. An escaping exception broke that promise and took the caller
  // down with it — one bad key returned 500 from /api/cron/weekly-digest
  // part-way through the run, abandoning every family after the first.
  try {
    const payload = {
      from: FROM_EMAIL,
      to,
      subject,
      react,
      ...(replyTo ? { replyTo } : {}),
    };
    const sender = getResend().emails;
    // Bounded (lib/email-deadline.ts): the SDK's fetch has no timeout, and one
    // provider connection that never answers held a cron's whole batch past
    // its budget into the platform's kill. Past the deadline this is a failed
    // send like any other.
    const { error } = await withEmailDeadline(idempotencyKey
      ? sender.send(payload, { idempotencyKey })
      : sender.send(payload));

    if (error) {
      console.error('[email failed]', error);
      return { ok: false };
    }
    return { ok: true };
  } catch (cause) {
    console.error('[email failed — the provider threw]', cause);
    return { ok: false };
  }
}
