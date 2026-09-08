// The family's unified inbox (`family_inbox_messages`, 0214): the calls, texts
// and emails that arrive at the household's own number and @bubaly.com address.
//
// The table has NO client write policy — provisioning and inbound webhooks
// write with the service role, and the family-facing controls go through
// parent-gated server actions — so the `scope.db` a caller hands in here has
// to be the service client. That is exactly why the family filter below is
// explicit and not left to RLS: with the service role, `family_id` is the only
// tenancy boundary there is.
import 'server-only';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type InboxMessageStatus = 'read' | 'archived';

/**
 * Mark one of the family's inbox messages read or archived.
 *
 * Managers only (a cron or the executor may act as `system`): the household's
 * front-desk mail is the parents' to file, and a child archiving a message
 * about a dentist appointment would make it vanish from "Needs you" without
 * anyone having answered it.
 */
export async function setInboxMessageStatus(
  scope: ServiceScope,
  messageId: string,
  status: InboxMessageStatus,
): Promise<ServiceResult<{ id: string; status: InboxMessageStatus }>> {
  const id = messageId?.trim();
  if (!id) return fail('Which message?', { code: SERVICE_CODES.invalidInput });
  if (scope.role !== 'system' && !isManager(scope.role)) {
    return fail('Only a parent or adult can file a family message.', { code: SERVICE_CODES.denied });
  }
  const { data, error } = await scope.db
    .from('family_inbox_messages')
    .update({ status })
    .eq('family_id', scope.familyId)
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[service:inbox] message status update failed', error);
    return fail(describeDbError(error, 'Could not update that message.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That message could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id, status });
}

/** Archive a message: it leaves "Needs you" and the inbox's default view, and is kept. */
export function archiveInboxMessage(scope: ServiceScope, messageId: string) {
  return setInboxMessageStatus(scope, messageId, 'archived');
}
