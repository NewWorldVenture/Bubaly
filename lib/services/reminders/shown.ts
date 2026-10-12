// lib/services/reminders/shown.ts — a reminder acted on by its id is one its
// actor may be shown.
//
// A reminder an Autopilot card made is listed only to the card's readers
// (lib/autopilot/reminder-cards.ts): a teen the insurance policy does not name
// is never listed "Renew dental insurance (Smile Co)". But the reminder tools
// take an explicit `reminder_id` as well as a partial title, and only the title
// was matched against what the reader may see. An id went straight to
// completeReminder / snoozeReminder, which scoped by id and family alone, so
// the same teen completed or snoozed the policy's reminder by its id — through
// the real dispatcher, which admits a low-risk scheduling edit on the teen
// risk tier — and was read its title back in the reply and the ledger.
//
// So every service entrypoint that acts on ONE reminder by its id asks here
// first. The row is read by id and family with the links a reminder carries
// back to its card (`idempotency_key` and the tags on `family_reminders`), the
// family's cards are read afresh with the server's mints (lib/services/autopilot
// suggestionReminderKey and suggestionSourceTag), and the reader's rule
// (`visibleReminders`) decides: a row it drops answers exactly what an unknown
// id answers, word for word, so nothing of the row — its title, its detail,
// that it exists — reaches the reply, the ledger's summary, the activity trail
// or a log line. A row the reader keeps goes on to the caller's write, which
// stays scoped by id and family and confirmed as before. The actor is the
// scope's role and member: a member's own, an assistant acting for a teen is
// that teen, an approved AI request is the approver's role acting for the
// asker, and a system scope is no manager — so it is not shown a policy's.
//
// What still acts: a reminder with no link to a card (one somebody wrote, an
// assigned one, an appointment's) is everyone's in the family and is never
// held up here; a card's reminder acts for the card's readers — the managers
// always, the member a policy names, a not-guests card's non-guests; a link no
// card answers stays with the managers alone, as it is listed.
//
// A FAILED READ REFUSES. If the reminder, or the cards a linked one needs,
// cannot be read, nothing is written — a manager's write included, though the
// rule keeps every card's reminder for the managers — and the answer is "could
// not load" (retryable when it was the cards), never a guess either way. It
// carries no title either; in an outage of the cards it can tell a reader
// that the id is a card's, which a refusal never does.
//
// WHAT THIS DOES NOT CLOSE, plainly:
//
//   - It is check-then-write, not one statement. Between these reads and the
//     caller's write, the card's audience can change (its member, its kind,
//     the card deleted or re-minted) or the reminder's own links can (its
//     tags rewritten); the write, scoped by id and family only, does not see
//     that. The window is a few round trips, and it is not atomic against a
//     concurrent audience change.
//   - It guards the server's entrypoints only. A signed-in member's own
//     client can still write a `family_reminders` row by id through PostgREST
//     directly — the reminders module updates them that way, for its edits
//     and its tick-off — and such direct authenticated SDK writes are bounded
//     only by the reminder tables' family-wide RLS: 0479's SELECT and UPDATE
//     on the reminders are the whole family's, and 0486 narrows the cards,
//     not their reminders. That SQL boundary is the owner's, and is being
//     tested separately.
//
// Import direction: lib/services/autopilot imports the reminders service
// (createReminder), and the reminders service imports this module, which
// imports the autopilot service back for its mints. Neither side touches the
// other while it is loading — both are called only once a request runs — so
// the cycle is inert; the browser's Web Crypto twins
// (lib/autopilot/reminder-key.ts) remain for the reads that run client-side.
import 'server-only';
import { reminderCardsReader, visibleReminders } from '@/lib/autopilot/reminder-cards';
import { suggestionReminderKey, suggestionSourceTag } from '@/lib/services/autopilot';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

/** What an id this actor may not act on answers: an unknown id's answer, word for word. */
export const REMINDER_NOT_FOUND = 'That reminder could not be found.';

/** What a reminder, or the cards that say whose it is, that could not be read answers. */
const REMINDER_UNREADABLE = 'Could not load that reminder.';

/**
 * Whether the scope's actor may act on this one `family_reminders` row: ok with
 * its id when the reader's rule keeps it; the unknown id's notFound when the
 * row is not the family's or the rule drops it; a db failure when the row
 * could not be read, and a retryable one when its cards could not be. Call it
 * before the write, and keep the write scoped by id and family.
 */
export async function requireShownReminder(scope: ServiceScope, reminderId: string): Promise<ServiceResult<{ id: string }>> {
  // The columns the reader's rule reads, as this table has them.
  const { data: row, error } = await scope.db
    .from('family_reminders')
    .select('id, member_id, idempotency_key, tags')
    .eq('id', reminderId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:reminders] reminder visibility read failed', error);
    return fail(describeDbError(error, REMINDER_UNREADABLE), { code: SERVICE_CODES.db });
  }
  if (!row) return fail(REMINDER_NOT_FOUND, { code: SERVICE_CODES.notFound });

  // Fresh for this one row: the cards as they stand now, not a list's earlier read.
  let cardsUnread = false;
  const cards = reminderCardsReader(scope.db, scope.familyId, {
    keyOf: (cardId) => suggestionReminderKey(scope.familyId, cardId),
    sourceTagOf: suggestionSourceTag,
    onError: (cause) => {
      cardsUnread = true;
      console.error('[service:reminders] autopilot reminder cards read failed', cause);
    },
  });
  const shown = await visibleReminders([row], { role: scope.role, memberId: scope.memberId }, cards);
  // Read only for a row that links to a card; failed, nothing is written —
  // not even a manager's, whom the rule would have kept without the cards.
  if (cardsUnread) return fail(REMINDER_UNREADABLE, { code: SERVICE_CODES.db, retryable: true });
  if (shown.length !== 1) return fail(REMINDER_NOT_FOUND, { code: SERVICE_CODES.notFound });
  return ok({ id: row.id });
}
