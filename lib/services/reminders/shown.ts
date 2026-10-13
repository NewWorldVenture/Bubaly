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
// scope's reader (`reminderViewer`): a member's own role and member, an
// assistant acting for a teen is that teen, and a system scope is no manager —
// so it is not shown a policy's. An approved AI request is its ASKER's: the
// replay runs with the approver's role (lib/services/approvals
// scopeForApprovedWork), and read by that role a teen's by-id "complete" of a
// policy's reminder, held for a parent on an opaque card, was admitted as the
// parent's, completed it, and stamped its title on the family-readable
// approval and the activity trail. The scope's `viewer` names the asker, and
// is preferred here, by the title lookup and by the due list.
//
// The same rule reads a SET of reminder rows (`shownReminders`): a run's
// verification (lib/ai/runs/verify.ts) re-reads `family_reminders` by id, by a
// list of ids or by a count over any columns, and every one of those is a
// one-row-by-id read when the plan names the id. Each keeps only the rows this
// reader is shown before it compares, finds or counts, so a hidden reminder's
// "title is …", "exists" and "at least one with id and title" all answer as an
// id the family does not hold.
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
//   - It is asked when the work RUNS, not when a request is held for a
//     parent: a held "complete <id>" still files its card (the tool's own
//     wording and the id, never the row's title), and the replay answers it
//     as an unknown id for the asker.
//
// Import direction: lib/services/autopilot imports the reminders service
// (createReminder), and the reminders service imports this module, which
// imports the autopilot service back for its mints. Neither side touches the
// other while it is loading — both are called only once a request runs — so
// the cycle is inert; the browser's Web Crypto twins
// (lib/autopilot/reminder-key.ts) remain for the reads that run client-side.
import 'server-only';
import { reminderCardsReader, visibleReminders, type ReminderLink } from '@/lib/autopilot/reminder-cards';
import type { AudienceViewer } from '@/lib/autopilot/audience';
import { suggestionReminderKey, suggestionSourceTag } from '@/lib/services/autopilot';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

/** What an id this actor may not act on answers: an unknown id's answer, word for word. */
export const REMINDER_NOT_FOUND = 'That reminder could not be found.';

/** What a reminder, or the cards that say whose it is, that could not be read answers. */
const REMINDER_UNREADABLE = 'Could not load that reminder.';

/** A `family_reminders` row as the reader's rule reads it: its id and the links back to a card. */
export type ShownReminderRow = ReminderLink & { id: string };

/**
 * Whom a reminder is shown to, or acted on for, under this scope: the asker an
 * approved AI request names (`scope.viewer`), else the scope's own role and
 * member.
 */
export function reminderViewer(scope: ServiceScope): AudienceViewer {
  return scope.viewer ?? { role: scope.role, memberId: scope.memberId };
}

/**
 * This scope as its reminder reader: the same client and family, with the
 * viewer's role and member in place of the scope's. Only for a READ that takes
 * its reader from the scope (the assistant's title lookup, the due list); a
 * write keeps the scope it was given.
 */
export function asReminderReader(scope: ServiceScope): ServiceScope {
  if (!scope.viewer) return scope;
  return { ...scope, role: scope.viewer.role, memberId: scope.viewer.memberId };
}

/**
 * The `family_reminders` rows this scope's reader may be shown, by the
 * reader's rule over the family's cards read afresh with the server's mints.
 * The cards are read only when a row links to one; a failed read of them is a
 * retryable failure, never a guess either way.
 */
export async function shownReminders<T extends ShownReminderRow>(scope: ServiceScope, rows: T[]): Promise<ServiceResult<T[]>> {
  // Fresh for these rows: the cards as they stand now, not a list's earlier read.
  let cardsUnread = false;
  const cards = reminderCardsReader(scope.db, scope.familyId, {
    keyOf: (cardId) => suggestionReminderKey(scope.familyId, cardId),
    sourceTagOf: suggestionSourceTag,
    onError: (cause) => {
      cardsUnread = true;
      console.error('[service:reminders] autopilot reminder cards read failed', cause);
    },
  });
  const shown = await visibleReminders(rows, reminderViewer(scope), cards);
  // Failed, nothing is kept — not even for a manager, whom the rule would have
  // kept every card's reminder for without the cards.
  if (cardsUnread) return fail(REMINDER_UNREADABLE, { code: SERVICE_CODES.db, retryable: true });
  return ok(shown);
}

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

  // Failed, nothing is written — a manager's write included.
  const shown = await shownReminders(scope, [row]);
  if (!shown.ok) return shown;
  if (shown.data.length !== 1) return fail(REMINDER_NOT_FOUND, { code: SERVICE_CODES.notFound });
  return ok({ id: row.id });
}
