// The family's unified inbox (`family_inbox_messages`, 0214): the calls, texts
// and emails that arrive at the household's own number and @bubaly.com address.
//
// `family_inbox_messages` grants family members SELECT and nothing else: every
// write is privileged, done by the inbound webhooks with the service role or by
// a server action that has already proved membership. So these functions take a
// `ServiceScope` whose `db` is the SERVICE client, and they still filter
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
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type InboxMessage = Tables<'family_inbox_messages'>;

/** The values `family_inbox_messages.status` admits (0214). */
export const INBOX_STATUSES = ['new', 'read', 'archived'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/**
 * Kept as an alias rather than a second union: filing a message is the same act
 * whichever caller asks for it, and two status types would drift.
 */
export type InboxMessageStatus = InboxStatus;

export function isInboxStatus(value: string): value is InboxStatus {
  return (INBOX_STATUSES as readonly string[]).includes(value);
}

/**
 * Filing is a manager's act (a cron or the executor may act as `system`): the
 * household's front-desk mail is the parents' to file, and a child archiving a
 * message about a dentist appointment would make it vanish from "Needs you"
 * without anyone having answered it.
 */
function mayFile(scope: ServiceScope): boolean {
  return scope.role === 'system' || isManager(scope.role);
}

/** Read one message, scoped to the family. Any member may read the inbox. */
export async function loadInboxMessage(scope: ServiceScope, messageId: string): Promise<ServiceResult<InboxMessage>> {
  const id = messageId?.trim();
  if (!id) return fail('Which message?', { code: SERVICE_CODES.invalidInput });
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .select('*')
    .eq('id', id)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:inbox] message read failed', error);
    return fail(describeDbError(error, 'Could not open that message.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message is no longer in the inbox.', { code: SERVICE_CODES.notFound });
  return ok(data as InboxMessage);
}

/**
 * Mark a message handled after durable work exists: a persisted intake request
 * or an executed, approved tool. School proposals archive the source in this
 * same write; ordinary inbox filing keeps the existing read status.
 */
export async function markInboxMessageHandled(
  scope: ServiceScope,
  messageId: string,
  status: 'read' | 'archived' = 'read',
): Promise<ServiceResult<InboxMessage>> {
  const id = messageId?.trim();
  if (!id) return fail('Which message?', { code: SERVICE_CODES.invalidInput });
  if (!mayFile(scope)) {
    return fail('Only a parent or adult can file a family message.', { code: SERVICE_CODES.denied });
  }
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .update({ ai_handled: true, status })
    .eq('id', id)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:inbox] handled flag write failed', error);
    return fail(describeDbError(error, 'Could not mark that message handled.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message is no longer in the inbox.', { code: SERVICE_CODES.notFound });
  return ok(data as InboxMessage);
}

/**
 * Move a message between new / read / archived. Managers (or `system`) only.
 *
 * Answers the id and the status it settled on rather than the whole row: no
 * caller needs more than that from a filing, and a narrow return keeps the
 * message body out of results that only ever get checked for `ok`.
 * `markInboxMessageHandled` is the one that hands back the row, because its
 * caller reads `ai_handled` off it.
 */
export async function setInboxMessageStatus(
  scope: ServiceScope,
  messageId: string,
  status: InboxStatus,
): Promise<ServiceResult<{ id: string; status: InboxStatus }>> {
  const id = messageId?.trim();
  if (!id) return fail('Which message?', { code: SERVICE_CODES.invalidInput });
  if (!isInboxStatus(status)) {
    return fail('That is not a status the inbox has.', { code: SERVICE_CODES.invalidInput });
  }
  if (!mayFile(scope)) {
    return fail('Only a parent or adult can file a family message.', { code: SERVICE_CODES.denied });
  }
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .update({ status })
    .eq('id', id)
    .eq('family_id', scope.familyId)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[service:inbox] message status update failed', error);
    return fail(describeDbError(error, 'Could not update that message.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return fail('That message could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id, status });
}

/** Archive a message: it leaves "Needs you" and the inbox's default view, and is kept. */
export async function archiveInboxMessage(scope: ServiceScope, messageId: string) {
  return setInboxMessageStatus(scope, messageId, 'archived');
}
