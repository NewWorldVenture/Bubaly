// The chat toolbox's all-day event, as the DATE labels it names.
//
// The assistant is told to speak the family's clock ("ISO 8601 in the family
// time zone"), so an all-day event often arrives as a zone-less midnight:
// `2026-10-15T00:00:00`. On that clock a Los Angeles midnight is 07:00Z — not a
// whole day — and `calendar.createEvent` (like `updateEvent` and
// `rescheduleEvent`) refuses it, as it should for a time of day. In chat it is
// how the model says "the 15th", so `create_calendar_event` reads it as that
// date.
//
// The reading happens on the CHAT path only, and before the trust wrapper files
// anything (lib/assistant/trust-wrapper.ts): an approval card stores the
// `{name, args}` its replay runs through `calendar.createEvent`, so it has to
// hold the DATE label that strict tool accepts, not the midnight it refuses.
// A bound with a zone is an instant the caller chose and is left alone, as is
// any other time of day, which the event write then refuses in words that say
// why (`calendar.allDayNeedsDate`).

/** A wall reading of exactly midnight with no zone: "2026-10-15T00:00", ":00" or ":00.000". */
const ZONELESS_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0{1,9})?)?$/;

function dateLabelOf(value: unknown): unknown {
  return typeof value === 'string' ? ZONELESS_MIDNIGHT.exec(value.trim())?.[1] ?? value : value;
}

/**
 * `create_calendar_event`'s arguments with an all-day event's zone-less
 * midnights read as their dates. `all_day` is read as the toolbox reads it
 * (`Boolean(a.all_day)`). Anything else is returned as given — the same object
 * when nothing changed.
 */
export function allDayBoundsAsDates(args: Record<string, unknown>): Record<string, unknown> {
  if (!args.all_day) return args;
  const next: Record<string, unknown> = { ...args };
  let changed = false;
  for (const key of ['starts_at', 'ends_at'] as const) {
    if (!(key in args)) continue;
    const label = dateLabelOf(args[key]);
    if (label !== args[key]) {
      next[key] = label;
      changed = true;
    }
  }
  return changed ? next : args;
}
