import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

/**
 * Why a refusal is a TYPE and not a sentence.
 *
 * `requireMarketingAdmin` throws to refuse, so each route learns about it in a
 * catch block alongside every genuine fault — and the two routes that handle it
 * told them apart by searching the message for 'sign in', 'permission' or
 * 'Forbidden'. That made the HTTP status a property of the English wording: the
 * AI route looked for 'Forbidden', which this function has never said, so a
 * non-admin was answered **500, "Could not generate. Check that the OpenAI API
 * key is set."** — a permissions refusal wearing an outage's clothes, pointing
 * whoever reads the logs at the wrong subsystem entirely (F-E09).
 *
 * No access was ever granted; the request is refused either way. What was wrong
 * is that nothing could tell the difference, and rewording a message — or
 * translating one — would silently move a status again.
 */
export class MarketingAuthorizationError extends Error {
  readonly reason: 'unauthenticated' | 'forbidden';
  constructor(reason: 'unauthenticated' | 'forbidden', message: string) {
    super(message);
    this.name = 'MarketingAuthorizationError';
    this.reason = reason;
  }
}

/** True for a refusal by `requireMarketingAdmin`, and for nothing else. */
export function isMarketingAuthorizationError(error: unknown): error is MarketingAuthorizationError {
  return error instanceof MarketingAuthorizationError;
}

/**
 * Defense-in-depth guard for every marketing server action / route handler.
 * The admin layout already gates /admin to super admins, but actions must
 * re-verify independently. Returns the service-role client + the actor.
 */
export async function requireMarketingAdmin(): Promise<{
  supabase: DB;
  actorId: string;
  actorEmail: string | null;
}> {
  const user = await getUser();
  if (!user) throw new MarketingAuthorizationError('unauthenticated', 'Please sign in to continue.');
  const ok = await isSuperAdmin();
  if (!ok) throw new MarketingAuthorizationError('forbidden', 'You do not have permission to manage marketing settings.');
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
