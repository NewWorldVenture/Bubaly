// The id a browser mints for one save attempt, so a retry of that attempt is
// recognisably the same save.
//
// §7's first symptom is a parent on a patchy connection tapping Save twice and
// getting two identical school concerts. The button disables while a request is
// in flight, so the tap that actually duplicates is the one AFTER an apparent
// failure: the write committed, the response never arrived, the modal showed an
// error, and the parent pressed Save again. Nothing on either side can tell that
// second request from a new one — unless the client says so.
//
// A submission id is that statement. It is minted once per composition (a modal
// opening, a slot being booked) and held across every retry of it, so:
//
//   - a retried save carries the SAME id and the server returns the row the
//     first attempt already wrote;
//   - two deliberately identical events — two children with a 4pm piano lesson —
//     are composed separately, carry DIFFERENT ids, and both get created.
//
// The second half is why this is a client-minted id rather than a hash of the
// event's own fields: a natural key over (title, start) cannot tell the piano
// lessons apart, and would silently drop one.
//
// Not a security boundary. The value only ever reaches a family-scoped
// idempotency key, so the worst a forged one can do is deduplicate the caller's
// own write against their own family's row.

/** UUID shape, which is what both the native generator and the fallback produce. */
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A fresh submission id.
 *
 * `crypto.randomUUID` needs a secure context, which every real page has and a
 * few test/preview shells do not; the fallback keeps the same shape so callers
 * and `isSubmissionId` never have to care which one ran.
 */
export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Whether a value from a request body is a submission id.
 *
 * A server MUST check this before using one, because the value becomes a column
 * in a unique index: an unbounded string from a client is a row nobody can
 * predict the size of. A value that fails is not an error — the caller falls
 * back to today's un-deduplicated write, so an old cached bundle that sends
 * nothing still saves.
 */
export function isSubmissionId(value: unknown): value is string {
  return typeof value === 'string' && SUBMISSION_ID.test(value);
}
