import 'server-only';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { canonicalMailbox } from '@/lib/server/canonical-mailbox';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { createServiceClient } from '@/lib/supabase/server';

// The form_submitted automation, fired from a PUBLIC endpoint (/api/contact,
// /api/forms/submit). Nobody is signed in there, so the recipient is an address
// the caller only claims to own and the name is whatever they typed. Fired as
// is, that made Bubaly's own sender a relay: one IP could mail a stranger's
// inbox thousands of times a day ("each submission is a new subject key, so
// nothing dedups"), and every mail opened with the caller's words — a URL and
// "your account will be closed" read fine after HTML escaping.
//
// Two bounds, both decided BEFORE the event and neither allowed to reach the
// HTTP response (the routes answer the same whatever happens here):
//
//   • one automation mail per inbox per day, keyed on the canonical mailbox
//     (lib/server/canonical-mailbox.ts), so neither rotating IPs nor `+tags`
//     lifts it — the per-address control /api/blog/subscribe already had;
//   • the greeting takes a name only when it plainly IS one (greetingName), and
//     says "there" otherwise, so the caller has no sentence of their own in it.

export const PUBLIC_AUTOMATION_WINDOW_MS = 86_400_000;

/**
 * A visitor-typed name, only if it reads as a name: letters (any script),
 * spaces, apostrophes and hyphens, at most 40 characters and three words.
 * Anything else — a URL, digits, punctuation, a paragraph, or a short sentence
 * with no punctuation at all ("there your Bubaly account will be closed") — is
 * null, and the greeting falls back to its fixed "there".
 */
export function greetingName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 40) return null;
  if (!/^\p{L}[\p{L}\p{M}'’ -]*$/u.test(name)) return null;
  if (name.split(' ').length > 3) return null;
  return name;
}

export type PublicFormSubmitted = {
  email: string | null;
  name: string | null;
  subjectKey: string;
  context: Record<string, unknown>;
};

/**
 * Fire form_submitted for a public submission, at most once per inbox per day.
 * Returns what it did, for logs and tests; callers must not answer from it.
 *
 * On the SERVICE client, always: the per-inbox key names an address, not a
 * signed-in caller, and rate_limit_hit (0179) refuses such a key from a session.
 */
export async function firePublicFormSubmitted(params: PublicFormSubmitted): Promise<'fired' | 'throttled'> {
  const supabase = createServiceClient();
  if (params.email) {
    const perInbox = await enforceRequestRateLimit(
      supabase,
      `automation:form_submitted:${canonicalMailbox(params.email)}`,
      { limit: 1, windowMs: PUBLIC_AUTOMATION_WINDOW_MS },
    );
    if (!perInbox.ok) return 'throttled';
  }
  await fireAutomationEvent(supabase, {
    trigger: 'form_submitted',
    email: params.email,
    name: greetingName(params.name),
    subjectKey: params.subjectKey,
    context: params.context,
  });
  return 'fired';
}
