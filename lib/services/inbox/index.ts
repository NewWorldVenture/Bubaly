// The household inbox's write side.
//
// `family_inbox_messages` (0214) grants family members SELECT and nothing else:
// every write is privileged, done by the inbound webhooks with the service role
// or by a server action that has already proved membership. So these functions
// take a `ServiceScope` whose `db` is the SERVICE client, and they still filter
// `family_id` explicitly — a service-role client has no RLS to fall back on, so
// the tenancy check has to be in the query.
//
// WHAT CANNOT BE WRITTEN HERE, AND WHY: the table has no `request_id`,
// `handled_at`, `paperwork_item_id` or `member_id` column, so "Bubaly filed this
// with the planner as request X at 09:12" cannot be persisted. What CAN be
// persisted is `ai_handled` — a boolean the row already carries — and that is
// therefore the only handled claim the UI is allowed to make. The DDL that
// would let the row name its request is listed in the work queue's migration
// asks; nothing here fakes it in the meantime.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type InboxMessage = Tables<'family_inbox_messages'>;

/** The values `family_inbox_messages.status` admits (0214). */
export const INBOX_STATUSES = ['new', 'read', 'archived'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export function isInboxStatus(value: string): value is InboxStatus {
  return (INBOX_STATUSES as readonly string[]).includes(value);
}

/** Read one message, scoped to the family. `null` data means "no such row here". */
export async function loadInboxMessage(scope: ServiceScope, messageId: string): Promise<ServiceResult<InboxMessage>> {
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .select('*')
    .eq('id', messageId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[services/inbox] message read failed', error);
    return fail(describeDbError(error, 'Could not open that message.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message is no longer in the inbox.', { code: SERVICE_CODES.notFound });
  return ok(data as InboxMessage);
}

/**
 * Mark a message handled. Called ONLY after something durable exists — a
 * persisted `ai_requests` row — because `ai_handled` is what the inbox renders
 * as "Handled", and a flag set before the work was filed would be a claim the
 * database cannot back.
 */
export async function markInboxMessageHandled(scope: ServiceScope, messageId: string): Promise<ServiceResult<InboxMessage>> {
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .update({ ai_handled: true, status: 'read' })
    .eq('id', messageId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[services/inbox] handled flag write failed', error);
    return fail(describeDbError(error, 'Could not mark that message handled.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message is no longer in the inbox.', { code: SERVICE_CODES.notFound });
  return ok(data as InboxMessage);
}

/** Move a message between new / read / archived. */
export async function setInboxMessageStatus(
  scope: ServiceScope,
  messageId: string,
  status: InboxStatus,
): Promise<ServiceResult<InboxMessage>> {
  if (!isInboxStatus(status)) {
    return fail('That is not a status the inbox has.', { code: SERVICE_CODES.invalidInput });
  }
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .update({ status })
    .eq('id', messageId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[services/inbox] status write failed', error);
    return fail(describeDbError(error, 'Could not update that message.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message is no longer in the inbox.', { code: SERVICE_CODES.notFound });
  return ok(data as InboxMessage);
}

/** Archive a message — the inbox's "done with this" without deleting history. */
export async function archiveInboxMessage(scope: ServiceScope, messageId: string): Promise<ServiceResult<InboxMessage>> {
  return setInboxMessageStatus(scope, messageId, 'archived');
}
