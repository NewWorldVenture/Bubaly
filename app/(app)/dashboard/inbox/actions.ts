'use server';

// "Handle it" — the one button that turns an inbox row into work Bubaly is
// actually doing.
//
// It files the message through the SAME intake every Ask Bubaly entry uses
// (`submitRequest`, intent classified from the text), so the trust gating, the
// approval spine and the run ledger are the ones already in place.
//
// THE WORDS ARE SOMEONE ELSE'S. The member asked for the message to be dealt
// with; they did not write it, and whoever did can put anything in it. So it is
// filed as an inbox hand-off (`origin: 'inbox'`, a `handle_it` request): the
// planner reads the message fenced as data, and every change the plan would
// make — an event, a task, a notification — waits for a parent or adult to
// approve it, whoever pressed the button (lib/ai/runs/executor.ts runStep).
//
// WHO MAY PRESS IT: a parent or adult, as for every other way of filing a
// family message (lib/services/inbox `mayFile`). The refusal comes FIRST: it
// used to come from `markInboxMessageHandled`, after `submitRequest` had
// already filed a request and planned a run — so a teen was told it failed,
// the message stayed "not handled", and the parent who pressed next filed it
// a second time.
//
// THE HANDLED CLAIM: before filing, the row is CLAIMED (`ai_handled` set only
// where it is still false), so two parents pressing together file once: the
// second finds it already with Bubaly. If the intake then fails, the claim is
// given back and the row says "not handled" again, because it isn't.
//
// WHAT THIS CANNOT PERSIST: `family_inbox_messages` has no `request_id` column,
// so the created run id is returned to the caller for THIS response only — the
// queue can link to the run it just started, but a reload cannot recover that
// link. Adding `request_id uuid references ai_requests` + `handled_at
// timestamptz` is the migration the work queue lists; until it exists, the UI
// says only what the row can prove.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { runPagePath } from '@/lib/ai/chat-request';
import { submitRequest } from '@/lib/ai/runs/intake';
import { isAIConfigured } from '@/lib/ai/provider';
import { assertAIAccess } from '@/lib/server/ai-access';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { scopeFromUserContext } from '@/lib/services/scope';
import {
  archiveInboxMessage, claimInboxMessageForFiling, loadInboxMessage, markInboxMessageHandled, releaseInboxMessageClaim,
} from '@/lib/services/inbox';
import { isManager } from '@/lib/constants/roles';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';

export type HandleInboxResult =
  | {
      ok: true;
      /** Where the run this filed lives — for THIS response only; the row cannot store it. */
      runPath: string | null;
      /** True only because the row now says `ai_handled`. */
      handled: boolean;
    }
  | { ok: false; error: string; code?: string };

/** Same window as POST /api/ai/requests: one budget per user across every door. */
const REQUEST_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/** How much of a message the planner is given. Long threads are the norm; a whole one is not useful. */
const MAX_HANDLE_CHARS = 4_000;

/**
 * Compose the text the planner sees from the row's own words. Kept pure and
 * exported so a test can pin it without a database.
 */
async function inboxRequestText(input: { subject?: string | null; body?: string | null }): Promise<string> {
  const subject = (input.subject ?? '').replace(/\s+/g, ' ').trim();
  const body = (input.body ?? '').trim();
  return [subject, body].filter(Boolean).join('\n\n').slice(0, MAX_HANDLE_CHARS);
}

/** File one inbox message through the intake and mark it handled if — and only if — that worked. */
export async function handleInboxMessageAction(
  messageId: string,
  clientRequestId?: string | null,
): Promise<HandleInboxResult> {
  const t = await getTranslations();
  const startedAt = Date.now();
  if (!messageId) return { ok: false, error: t('inboxActions.thatMessageCouldNotBe'), code: 'not_found' };

  const ctx = await requireUserContext();
  // Before anything is read, limited or filed (see WHO MAY PRESS IT above).
  if (!isManager(ctx.active.role)) {
    return { ok: false, error: t('inboxActions.onlyAParentOrAdultCanHandle'), code: 'denied' };
  }
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  // Read through the CALLER's client: RLS proves this family may see the row
  // before any service-role write touches it.
  const message = await loadInboxMessage(scope, messageId);
  if (!message.ok) return { ok: false, error: message.error, code: message.code };
  if (message.data.ai_handled) {
    return { ok: true, runPath: null, handled: true };
  }

  const text = await inboxRequestText(message.data);
  if (!text) return { ok: false, error: t('inboxActions.thereIsNothingInThat'), code: 'empty_message' };

  const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, REQUEST_RATE_LIMIT);
  if (!limited.ok) return { ok: false, error: t('inboxActions.tooManyRequestsRightNow'), code: 'rate_limited' };
  const access = await assertAIAccess(ctx, { db: supabase });
  if (!access.ok) return { ok: false, error: access.error, code: access.code };
  if (!(await isAIConfigured())) {
    return { ok: false, error: t('inboxActions.bubalyIsNotConnectedTo'), code: 'not_configured' };
  }

  // Every write here needs the service role: 0214 gives members SELECT and no more.
  const writer = { ...scope, db: createServiceClient() };
  const claim = await claimInboxMessageForFiling(writer, messageId);
  if (!claim.ok) return { ok: false, error: claim.error, code: claim.code };
  // Someone else's press got there first: it is already with Bubaly.
  if (!claim.data) return { ok: true, runPath: null, handled: true };

  let filed: Awaited<ReturnType<typeof submitRequest>>;
  try {
    filed = await submitRequest(
      scope,
      { text, context: { module: 'inbox' }, clientRequestId: clientRequestId ?? null, origin: 'inbox' },
      { startedAtMs: startedAt },
    );
  } catch (error) {
    await giveBackClaim(writer, messageId);
    throw error;
  }
  if (!filed.ok) {
    await giveBackClaim(writer, messageId);
    return { ok: false, error: filed.error, code: filed.code };
  }

  // A request row exists. This also files the message as read; the handled
  // flag itself is already true from the claim, so a failure here does not
  // un-file anything — the request WAS filed, and the reply says so.
  const handled = await markInboxMessageHandled(writer, messageId);
  if (!handled.ok) console.error('[inbox] filed a request but could not mark the message read', { messageId, error: handled.error });

  revalidatePath('/dashboard/inbox');
  revalidatePath('/dashboard/front-desk');
  return {
    ok: true,
    runPath: filed.data.runId ? runPagePath(filed.data.runId) : null,
    handled: handled.ok ? handled.data.ai_handled === true : true,
  };
}

/** The intake failed: the message is not with Bubaly, so the row must not say it is. */
async function giveBackClaim(writer: Parameters<typeof releaseInboxMessageClaim>[0], messageId: string): Promise<void> {
  const released = await releaseInboxMessageClaim(writer, messageId);
  if (!released.ok) console.error('[inbox] could not release a filing claim after the intake failed', { messageId, error: released.error });
}

/** Archive an inbox message: out of the queue, still in the history. */
export async function archiveInboxMessageAction(messageId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  if (!messageId) return { ok: false, error: t('inboxActions.thatMessageCouldNotBe') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  const message = await loadInboxMessage(scope, messageId);
  if (!message.ok) return { ok: false, error: message.error };

  const archived = await archiveInboxMessage({ ...scope, db: createServiceClient() }, messageId);
  if (!archived.ok) return { ok: false, error: archived.error };
  revalidatePath('/dashboard/inbox');
  return { ok: true };
}
