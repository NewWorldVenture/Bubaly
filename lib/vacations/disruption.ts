// Travel disruption re-flow. Pure, AI-free and unit-tested, the way
// `conflicts.ts` and `packing.ts` are: a delayed flight or a lost hotel is
// exactly the moment a family cannot afford a hallucination.
//
// WHAT THIS DOES AND WHAT IT REFUSES TO DO. It moves the family's OWN plans —
// the itinerary rows they wrote — and it names everything a third party holds
// that a person now has to sort out. It never says a booking was rebooked,
// rescheduled or confirmed, because nothing here talks to an airline, a hotel
// or a restaurant. `toRebook` is the honest half of the answer.
//
// WHY THE INPUT CARRIES THE ANCHOR. 0070 gives `vacation_flights` a
// `timestamptz` arrival and `vacation_lodging` a `date` check-in, and neither
// table has a status column. Resolving either into the family's local day and
// clock needs a timezone, which is a service concern, so the caller resolves
// it once and passes `anchorDay`/`anchorTime` in. That keeps this module free
// of `Intl` and therefore deterministic in a test.
import { detectConflicts, type Conflict, type ConflictOptions, type ItemLike } from './conflicts';

const MINUTES_PER_DAY = 1440;
/** Hotels the world over let you in mid-afternoon; used when lodging carries no time. */
const DEFAULT_CHECK_IN_MIN = 15 * 60;

export type DisruptionKind = 'flight' | 'lodging';

export type DisruptionInput = {
  kind: DisruptionKind;
  /** The `vacation_flights` / `vacation_lodging` row id. */
  id: string;
  /** What a person calls it: "BA 274", "Hotel Arts". Used in the summary. */
  label: string;
  /** The local day the booking lands on, `YYYY-MM-DD`. */
  anchorDay: string;
  /** The local clock time it was due to clear — arrival, or check-in. `HH:MM`. */
  anchorTime?: string | null;
  delayMinutes?: number | null;
  cancelled?: boolean | null;
};

/** A third-party booking with a time, resolved into the family's local day/clock. */
export type ReservationLike = {
  id: string;
  name: string;
  day: string | null;
  time: string | null;
};

/** An itinerary row plus the one extra column that decides whether a person must call someone. */
export type ItineraryLike = ItemLike & { booked?: boolean | null };

export type ShiftedItem = {
  id: string;
  title: string;
  fromDay: string;
  fromStart: string | null;
  toDay: string;
  toStart: string | null;
  toEnd: string | null;
  /** True when the shift pushed the item past midnight onto the next day. */
  rolledOvernight: boolean;
};

export type RebookReason = 'cancelled' | 'unreachable' | 'missed_window';

export type RebookItem = {
  kind: DisruptionKind | 'reservation' | 'itinerary_item';
  id: string;
  title: string;
  reason: RebookReason;
  when: string | null;
};

export type DisruptionPlan = {
  /** True when there was nothing to react to — no delay and no cancellation. */
  noop: boolean;
  shiftedItems: ShiftedItem[];
  /** Everything a PERSON has to rebook. Nothing here has been rebooked. */
  toRebook: RebookItem[];
  /** Conflicts the shifted itinerary now has, by `conflicts.ts` rules. */
  conflicts: Conflict[];
  /** One honest English line, persisted on the itinerary and sent to the family. */
  summary: string;
};

function toMin(value: string | null | undefined): number | null {
  if (!value) return null;
  const [h, m] = value.split(':');
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function fromMin(total: number): string {
  const within = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = Math.floor(within / 60);
  const mm = within % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` plus n days, in plain calendar arithmetic (no timezone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return day;
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

function dayOf(item: ItineraryLike): string | null {
  return item.day_date ?? null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function anchorMinutes(input: DisruptionInput): number {
  const explicit = toMin(input.anchorTime);
  if (explicit !== null) return explicit;
  // A flight with no arrival on file disrupts the whole day; a hotel does not
  // start until check-in.
  return input.kind === 'lodging' ? DEFAULT_CHECK_IN_MIN : 0;
}

/**
 * Re-flow a trip around one disrupted booking.
 *
 * Delay: every timed itinerary item on the anchor day at or after the moment
 * the booking was due to clear moves forward by the delay, rolling onto the
 * next day when it crosses midnight. Reservations that fall inside the delay
 * window are missed — a person has to call them.
 *
 * Cancellation: nothing is moved, because there is nothing to move it to. A
 * cancelled flight strands the rest of that day (those plans need a person);
 * a cancelled hotel needs a bed, not a re-flow.
 */
export function replanDisruption(
  input: DisruptionInput,
  itinerary: ItineraryLike[],
  reservations: ReservationLike[] = [],
  options: ConflictOptions = {},
): DisruptionPlan {
  const cancelled = input.cancelled === true;
  const delay = Math.max(0, Math.round(input.delayMinutes ?? 0));
  const anchor = anchorMinutes(input);

  if (!cancelled && delay <= 0) {
    return {
      noop: true,
      shiftedItems: [],
      toRebook: [],
      conflicts: [],
      summary: `${input.label} is still on time — nothing on the itinerary moved.`,
    };
  }

  const onAnchorDay = itinerary.filter((item) => dayOf(item) === input.anchorDay);
  const afterAnchor = onAnchorDay.filter((item) => {
    const start = toMin(item.start_time);
    return start !== null && start >= anchor;
  });
  const reservationsAfterAnchor = reservations.filter((r) => {
    if (r.day !== input.anchorDay) return false;
    const at = toMin(r.time);
    return at !== null && at >= anchor;
  });

  const toRebook: RebookItem[] = [];

  if (cancelled) {
    toRebook.push({ kind: input.kind, id: input.id, title: input.label, reason: 'cancelled', when: input.anchorDay });
    if (input.kind === 'flight') {
      // No flight means the family is not where the rest of the day assumed.
      for (const item of afterAnchor) {
        toRebook.push({ kind: 'itinerary_item', id: item.id, title: item.title, reason: 'unreachable', when: item.start_time ?? input.anchorDay });
      }
      for (const r of reservationsAfterAnchor) {
        toRebook.push({ kind: 'reservation', id: r.id, title: r.name, reason: 'unreachable', when: r.time ?? input.anchorDay });
      }
    }
    return {
      noop: false,
      shiftedItems: [],
      toRebook,
      conflicts: detectConflicts(itinerary, options),
      summary: summarize(input, { cancelled: true, delay: 0, shifted: 0, rebook: toRebook.length }),
    };
  }

  const shiftedItems: ShiftedItem[] = [];
  const shiftedById = new Map<string, ItineraryLike>();

  for (const item of afterAnchor) {
    const start = toMin(item.start_time)!;
    const end = toMin(item.end_time);
    const newStart = start + delay;
    const dayOffset = Math.floor(newStart / MINUTES_PER_DAY);
    const toDay = addDays(input.anchorDay, dayOffset);
    const toStart = fromMin(newStart);
    const toEnd = end === null ? null : fromMin(end + delay);
    shiftedItems.push({
      id: item.id,
      title: item.title,
      fromDay: input.anchorDay,
      fromStart: item.start_time,
      toDay,
      toStart,
      toEnd,
      rolledOvernight: dayOffset > 0,
    });
    shiftedById.set(item.id, { ...item, day_date: toDay, day_id: dayOffset > 0 ? null : item.day_id, start_time: toStart, end_time: toEnd });
  }

  // A reservation someone else holds cannot be moved by us; if it starts
  // before the family can now get there, it is missed.
  for (const r of reservationsAfterAnchor) {
    const at = toMin(r.time)!;
    if (at < anchor + delay) {
      toRebook.push({ kind: 'reservation', id: r.id, title: r.name, reason: 'missed_window', when: r.time });
    }
  }

  const replanned = itinerary.map((item) => shiftedById.get(item.id) ?? item);
  return {
    noop: false,
    shiftedItems,
    toRebook,
    conflicts: detectConflicts(replanned, options),
    summary: summarize(input, { cancelled: false, delay, shifted: shiftedItems.length, rebook: toRebook.length }),
  };
}

function summarize(
  input: DisruptionInput,
  counts: { cancelled: boolean; delay: number; shifted: number; rebook: number },
): string {
  const what = counts.cancelled
    ? `${input.label} was cancelled on ${input.anchorDay}.`
    : `${input.label} is delayed ${plural(counts.delay, 'minute')} on ${input.anchorDay}.`;
  const moved = counts.shifted === 0
    ? 'Nothing on the itinerary could be moved automatically.'
    : `Moved ${plural(counts.shifted, 'itinerary item')} to match.`;
  // The vocabulary here is load-bearing: Bubaly has not contacted anybody.
  const rebook = counts.rebook === 0
    ? 'No booking needs rebooking.'
    : `${plural(counts.rebook, 'booking')} ${counts.rebook === 1 ? 'still needs' : 'still need'} a person to rebook — nothing was rebooked for you.`;
  return `${what} ${moved} ${rebook}`;
}
