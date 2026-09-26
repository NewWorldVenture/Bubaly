// lib/blog/subscribe-notice.ts — the half of the subscribe answer that does NOT
// travel back over HTTP.
//
// /api/blog/subscribe answers every accepted submission with the same bytes,
// because the person typing an address into a public form is not necessarily
// its owner. The answer used to carry `already`, so an anonymous caller could
// ask the form whether a given address was on the list — and, through
// `already: false` on an existing row, whether it had once subscribed and then
// opted out, which is the more sensitive of the two bits.
//
// Whatever is worth saying about THIS address is said here instead: mailed to
// the address itself, which only its owner can read. That is the whole trade —
// the welcome-back line is not lost, it is delivered somewhere the caller
// cannot see it.
//
// Two deliberate choices:
//
//   • English only, like every other mail this codebase sends. A reader's
//     language lives in a cookie and on no row (lib/i18n/server.ts:47 states
//     the assumption), and a subscriber is a bare address with no profile
//     behind it.
//   • The unsubscribe link is built from APP_URL, never from the request's
//     Host header. The recipient is not the sender here, so a link steered by
//     whoever POSTed the form would be a phishing vector with our return
//     address on it.

import { APP_URL } from '@/lib/email';
import { sendEmail } from '@/lib/server/email';

/** What an accepted submission actually did to the row. */
export type SubscribeOutcome = 'created' | 'reactivated' | 'already';

const SUBJECT: Record<SubscribeOutcome, string> = {
  created: 'You’re subscribed to the Bubaly blog',
  reactivated: 'You’re back on the Bubaly blog list',
  already: 'You’re already on the Bubaly blog list',
};

const LEAD: Record<SubscribeOutcome, string> = {
  created: 'You’re on the list — new Bubaly articles will land in this inbox.',
  reactivated:
    'Welcome back. This address had unsubscribed, and it has just been added to the Bubaly blog list again.',
  already:
    'This address is already on the Bubaly blog list, so nothing changed and you won’t get anything twice.',
};

/** The one-click unsubscribe link the blog's own GET handler already honors. */
export function blogUnsubscribeUrl(token: string): string {
  return `${APP_URL.replace(/\/+$/, '')}/api/blog/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * The notice body. Every outcome carries the unsubscribe link, because the one
 * case this mail exists for — somebody else typed this address into a public
 * form — is also the case where the reader wants out in one click.
 */
export function subscribeNoticeHtml(outcome: SubscribeOutcome, token: string): string {
  const url = blogUnsubscribeUrl(token);
  return [
    `<p>${LEAD[outcome]}</p>`,
    `<p>Didn’t ask for this? <a href="${url}">Unsubscribe in one click</a> — no account and no sign-in needed.</p>`,
    `<p style="color:#6b7280;font-size:12px">${url}</p>`,
  ].join('');
}

/**
 * Mail the notice.
 *
 * Never throws and never reports back: the route's answer is fixed before this
 * runs and must not move, so a provider outage cannot become the oracle the
 * response body no longer is. The address is kept out of the log line for the
 * same reason it is kept out of the response — it is somebody's identity, and
 * this endpoint is unauthenticated.
 */
export async function sendSubscribeNotice(
  to: string,
  outcome: SubscribeOutcome,
  token: string,
): Promise<void> {
  try {
    const sent = await sendEmail({
      to,
      subject: SUBJECT[outcome],
      html: subscribeNoticeHtml(outcome, token),
    });
    if (!sent.ok) console.error('[blog-subscribe] notice email was not delivered', { outcome });
  } catch (error) {
    console.error('[blog-subscribe] notice email threw', { outcome, error });
  }
}
