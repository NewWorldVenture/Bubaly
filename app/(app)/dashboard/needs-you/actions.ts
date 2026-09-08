// The decisions a "Needs you" card can take on the spot, for the three M5
// sources: confirm or dismiss a memory Bubaly inferred, and archive a message
// that arrived at the family's own number or address.
//
// Every action re-checks the role on the server. Kids and guests see the same
// list read-only; the buttons are only rendered for managers, but a button is
// not a permission, so the check is here where it counts. Writes go through
// the domain services (memory, inbox), which own the family scoping and the
// error copy, and every surface that renders the affected rows is revalidated
// so nothing keeps showing a card that has just been decided.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { isManager } from '@/lib/constants/roles';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { confirmFact, forgetFact } from '@/lib/services/memory';
import { archiveInboxMessage } from '@/lib/services/inbox';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

export type NeedsYouActionResult = { ok: true } | { ok: false; error: string };

/** Every page that renders the rows these actions change. */
const AFFECTED_PATHS = ['/home', '/dashboard/needs-you', '/dashboard/playbook', '/dashboard/knowledge', '/dashboard/contact-center'];

function refresh(): void {
  for (const path of AFFECTED_PATHS) revalidatePath(path);
}

/** Session + a manager check, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function decider() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false as const, error: t('needsYouActions.onlyAParentOrAdultCan') };
  return { ok: true as const, ctx, t };
}

/** Accept an inferred memory into confirmed family memory (`family_facts`). */
export async function confirmFactSuggestionAction(suggestionId: string): Promise<NeedsYouActionResult> {
  const d = await decider();
  if (!d.ok) return d;
  const id = String(suggestionId ?? '').trim();
  if (!id) return { ok: false, error: d.t('needsYouActions.thatSuggestionCouldNotBe') };
  try {
    const result = await confirmFact(scopeFromUserContext(d.ctx, await createServer()), id);
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return { ok: true };
  } catch (err) {
    console.error('[needs-you] confirm suggestion failed', err);
    return { ok: false, error: describeActionError(err, d.t('needsYouActions.couldNotConfirmThatMemory')) };
  }
}

/** Dismiss an inferred memory. It is kept as dismissed so the same inference is not re-suggested. */
export async function dismissFactSuggestionAction(suggestionId: string): Promise<NeedsYouActionResult> {
  const d = await decider();
  if (!d.ok) return d;
  const id = String(suggestionId ?? '').trim();
  if (!id) return { ok: false, error: d.t('needsYouActions.thatSuggestionCouldNotBe') };
  try {
    const result = await forgetFact(scopeFromUserContext(d.ctx, await createServer()), id, { kind: 'suggestion' });
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return { ok: true };
  } catch (err) {
    console.error('[needs-you] dismiss suggestion failed', err);
    return { ok: false, error: describeActionError(err, d.t('needsYouActions.couldNotDismissThatSuggestion')) };
  }
}

/**
 * Archive a message from the family's inbox. `family_inbox_messages` has no
 * client write policy, so the service runs on the service client and scopes
 * the write to the caller's family itself.
 */
export async function archiveInboxMessageAction(messageId: string): Promise<NeedsYouActionResult> {
  const d = await decider();
  if (!d.ok) return d;
  const id = String(messageId ?? '').trim();
  if (!id) return { ok: false, error: d.t('needsYouActions.thatMessageCouldNotBe') };
  try {
    const result = await archiveInboxMessage(scopeFromUserContext(d.ctx, createServiceClient()), id);
    if (!result.ok) return { ok: false, error: result.error };
    refresh();
    return { ok: true };
  } catch (err) {
    console.error('[needs-you] archive message failed', err);
    return { ok: false, error: describeActionError(err, d.t('needsYouActions.couldNotArchiveThatMessage')) };
  }
}
