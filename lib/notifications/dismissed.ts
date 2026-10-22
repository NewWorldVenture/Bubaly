/**
 * The `send_at` of a notification someone dismissed.
 *
 * A dismissal is kept as a row, not a DELETE: the notification generator
 * dedupes against the notifications table itself, so a deleted row was "new"
 * again on the next scan and came back — re-pushed and re-emailed — for as
 * long as its item stayed inside its reminder window.
 *
 * There is no `dismissed_at` column yet (a schema change, the owner's call),
 * so the row is parked at the end of time instead. Every surface that shows or
 * delivers a notification already reads only what is due (`send_at <= now`:
 * the bell, the list, the brief's listUnread, push dispatch and the email
 * digest, held by tests/notification-due-surfaces.test.ts), so a parked row is
 * shown and sent nowhere, while both dedupe reads — which do not filter on
 * `send_at` — still see it.
 */
export const DISMISSED_SEND_AT = '9999-12-31T00:00:00.000Z';
