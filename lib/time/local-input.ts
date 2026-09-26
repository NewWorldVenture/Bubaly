// lib/time/local-input.ts — the two halves of a `<input type="datetime-local">`.
//
// The control speaks naive wall clock — "2026-09-10T14:30", no zone. A
// `timestamptz` column speaks instants. Something has to convert, and the only
// rule that matters is that the two directions be INVERSES: whatever zone the
// prefill reads a stored instant in, the submit has to resolve the box back
// against the same one. Otherwise a Save that touches no field moves the event.
//
// They were not inverses. `components/modules/calendar-module.tsx` rendered the
// prefill with browser-LOCAL getters, and the box value went to the server as a
// naive string that `asStoredInstant`
// (`app/(app)/dashboard/calendar/actions.ts`) stamps with a bare `Z` — UTC. So
// every Save re-applied the reader's offset, and it COMPOUNDED. Replaying those
// two real functions against one 14:30 event, pressing Save three times with
// nothing edited:
//
//   Asia/Tokyo           14:30 -> 23:30 -> 08:30 (next day) -> 17:30
//   America/Los_Angeles  14:30 -> 07:30 -> 00:30 -> 17:30 (previous day)
//   Europe/Amsterdam     14:30 -> 16:30 -> 18:30 -> 20:30
//   UTC                  14:30 -> 14:30 -> 14:30 -> 14:30   (stable only here)
//
// And it was not only hand-made rows. A row synced from Google or an ICS feed is
// a genuine instant, and it drifted through the same edit path: two Saves in
// Tokyo carried a 09:00 event to 03:00 the following morning. Idempotency cannot
// be bought by knowing what a row means, because a hand-made row saved before
// this and a real instant from a feed are the same bytes. It is bought by making
// the two ends agree, which is all this file does.
//
// Both directions therefore live in one file so they cannot drift apart again,
// and the frame they share is the READER's clock — which is this calendar's
// frame by decision, not by accident. `lib/time/local-day.ts` keys every grid
// column and every event with the reader's day, and
// `tests/a-calendar-day-is-the-readers-day.test.ts` holds it there. Aligning the
// submit with that frame is what closes the round trip; giving one end a
// different frame is what opened it.
//
// What this deliberately does NOT settle is whose clock a typed time should mean
// when the person typing is not in the family's zone — the question
// `asStoredInstant`'s header defers. Answering it means reinterpreting rows
// already in the column, and nothing in a row says which convention wrote it, so
// it needs the existing rows decided first. That is a separate, larger change;
// this one changes no stored byte and no rendered time.
//
// Framework-free and safe in a client bundle: no `server-only`, no DOM, no Intl.

/**
 * The naive wall clock that a `datetime-local` box shows for an instant, as the
 * reader's own clock reads it. Empty for absent or unparseable input, which is
 * the empty box the control wants.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The naive wall clocks `asStoredInstant` would stamp a `Z` onto — the exact set this resolves instead. */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * The instant a `datetime-local` box value names on the reader's clock — the
 * inverse of `toLocalInput`.
 *
 * Matches exactly the shape `asStoredInstant` treats as naive, so there is no
 * value one of them resolves and the other stamps. Anything else passes through
 * untouched: a free slot from Find Time already arrives as an absolute instant
 * and has to reach the column unchanged. Blank returns undefined, which is the
 * "leave this field alone" the actions read.
 *
 * Built from components rather than `new Date(string)`. Engines agree on the
 * component form; they have historically disagreed about whether a naive string
 * is local or UTC, and being local is the whole point here.
 *
 * An hour the reader's zone skips at spring-forward (02:30 where the clocks go
 * 02:00 -> 03:00) resolves forward to the first reading that exists — the same
 * choice `instantForLocalTime` in `lib/time/zoned.ts` makes, and better than
 * dropping the event out of the day. From that instant on the round trip is
 * closed as usual, because the box then shows the hour that does exist.
 */
export function fromLocalInput(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  const m = NAIVE.exec(v);
  if (!m) return v;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? '').padEnd(3, '0')),
  );
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}
