import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

/**
 * A refusal from `requireMarketingAdmin`, carrying the status it deserves.
 *
 * The status used to live in the message. Two routes recovered it by reading
 * the English back — `message.includes('sign in') || message.includes('permission')`
 * — and the AI route matched on `'Forbidden'`, a word this module has never
 * said, so a non-admin there was told *"Could not generate. Check that the
 * OpenAI API key is set."* with a 500. No access was granted either way; the
 * cost was operational, since a permissions problem and an outage were the same
 * line in the logs and pointed the operator at the wrong subsystem.
 *
 * Carrying it as data means rewording the sentence can no longer change the
 * status code, which is what went wrong.
 */
export class MarketingAuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'MarketingAuthError';
    this.status = status;
  }
}

/**
 * Duck-typed rather than `instanceof`: a route handler and this module can end
 * up in different bundles, where `instanceof` compares two different classes
 * and silently answers false — which would reinstate the defect it is here to
 * remove.
 */
export function isMarketingAuthError(error: unknown): error is MarketingAuthError {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'MarketingAuthError'
    && ((error as { status?: unknown }).status === 401 || (error as { status?: unknown }).status === 403);
}

/**
 * What a route should put in the response body for a refusal.
 *
 * Fixed sentences chosen by status, NOT the error's own `message`, and not
 * `describeActionError(err)` either — that was the first attempt and it is
 * wrong twice over. `describeDbError` matches `'permission denied'`, which this
 * message does not contain, so nothing classifies it; `describeActionError`
 * then sees the described string equal the raw one, treats it as unclassified,
 * and returns "Something went wrong. Please try again." A refusal reported as a
 * generic fault is the whole defect this replaced, arriving by a different
 * road.
 *
 * Keeping it here rather than in each route means the raw-message ratchet in
 * tests/the-database-does-not-talk-to-the-browser.test.ts stays satisfied by
 * substance — there is no `.message` crossing the boundary — rather than by a
 * route renaming a variable to slip past it.
 */
export function marketingRefusalBody(error: MarketingAuthError): string {
  return error.status === 401 ? 'Please sign in to continue.' : 'Forbidden';
}

/**
 * Defense-in-depth guard for every marketing server action / route handler.
 * The admin layout already gates /admin to super admins, but actions must
 * re-verify independently. Returns the service-role client + the actor.
 *
 * The two messages are unchanged: 117 of the 121 call sites let this throw and
 * show the sentence, and it is a good sentence.
 */
export async function requireMarketingAdmin(): Promise<{
  supabase: DB;
  actorId: string;
  actorEmail: string | null;
}> {
  const user = await getUser();
  if (!user) throw new MarketingAuthError(401, 'Please sign in to continue.');
  const ok = await isSuperAdmin();
  if (!ok) throw new MarketingAuthError(403, 'You do not have permission to manage marketing settings.');
  return { supabase: createServiceClient(), actorId: user.id, actorEmail: user.email ?? null };
}

/** Fail a privileged mutation without exposing unclassified provider details. */
export function marketingActionFailure(operation: string, error: unknown): never {
  console.error(`[marketing-action] ${operation} failed`, error);
  throw new Error(describeActionError(error, `Could not ${operation}.`));
}

export async function logMarketingAudit(
  supabase: DB,
  entry: {
    actorId: string | null;
    actorEmail: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('marketing_audit_logs').insert({
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      action: entry.action,
      resource: entry.resource,
      resource_id: entry.resourceId ?? null,
      metadata: (entry.metadata ?? {}) as Database['public']['Tables']['marketing_audit_logs']['Insert']['metadata'],
    });
    if (error) console.error('[marketing audit] failed to write log', error);
  } catch (e) {
    console.error('[marketing audit] failed to write log', e);
  }
}
