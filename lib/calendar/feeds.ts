// lib/calendar/feeds.ts — pure helpers for calendar feed subscriptions.
// No Supabase / network: URL normalization, RRULE→recurrence mapping, and the
// ICS-event → calendar_events row shape are deterministic and unit-testable.
// The actual fetch + upsert lives in the server action / cron that imports this.

import type { IcsEvent } from '@/lib/sync/ics';

export type RecurrenceFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export const FEED_COLORS = ['blue', 'violet', 'green', 'amber', 'rose', 'teal'] as const;
export type FeedColor = (typeof FEED_COLORS)[number];

/**
 * Normalizes a user-supplied calendar URL for fetching:
 *  - webcal:// → https:// (the de-facto subscription scheme)
 *  - trims whitespace
 * Returns null when the result isn't a fetchable http(s) URL.
 */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const swapped = trimmed.replace(/^webcal:\/\//i, 'https://');
  let parsed: URL;
  try {
    parsed = new URL(swapped);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/** Maps an RFC 5545 RRULE value to our coarse recurrence enum. */
export function icsRruleToRecurrence(rrule: string | null | undefined): RecurrenceFreq {
  if (!rrule) return 'none';
  const m = rrule.match(/FREQ=([A-Z]+)/i);
  if (!m) return 'none';
  switch (m[1].toUpperCase()) {
    case 'DAILY': return 'daily';
    case 'WEEKLY': return 'weekly';
    case 'MONTHLY': return 'monthly';
    case 'YEARLY': return 'yearly';
    default: return 'none';
  }
}

export interface FeedEventRow {
  family_id: string;
  feed_id: string;
  external_uid: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  recurrence: RecurrenceFreq;
  category: 'general';
}

/**
 * The `external_uid` a VEVENT is stored under. A stand-alone event and a
 * recurring series master are stored under their UID; an EXCEPTION to a series
 * — a VEVENT carrying RECURRENCE-ID, which shares the master's UID and replaces
 * one occurrence — is stored under the UID joined to its RECURRENCE-ID by a
 * separator no UID can carry (`EXCEPTION_KEY_SEPARATOR`), so it never overwrites
 * the series it belongs to and the series never overwrites it.
 */
/**
 * The separator between a UID and a RECURRENCE-ID in an exception's key.
 *
 * RFC 5545 forbids control characters in a property value — every one except
 * HTAB, which TEXT admits as white space — so no UID a publisher can write
 * contains the separator, and both halves are stripped of the forbidden
 * controls below, so a UID that arrives with one anyway cannot impersonate an
 * exception. HTAB is kept: two legal UIDs that differ only by an interior tab
 * are two events, and stripping it made them one (second review on #908).
 * `#` was the separator before, and a stand-alone event whose UID happened to
 * be `series#2026-09-12T14:00:00.000Z` shared a key with the moved occurrence
 * of `series`: one of the two was lost in the plan, and when that occurrence
 * was cancelled the feed-scoped delete removed the stand-alone event (first
 * review on #908). 0x1F is a unit separator, storable in a text column and
 * safe in a PostgREST filter.
 */
export const EXCEPTION_KEY_SEPARATOR = '\u001F';
/** The controls RFC 5545 forbids in TEXT: everything below 0x20 except HTAB, and DEL. */
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000A-\u001F\u007F]/g;

/**
 * The `external_uid` a VEVENT is stored under: the bare UID for a master or a
 * one-off — the key every row imported before this change already has — and
 * UID + separator + RECURRENCE-ID for an exception, which no bare UID can equal.
 */
export function feedExternalUid(ev: Pick<IcsEvent, 'uid' | 'recurrenceId'>): string {
  const uid = ev.uid.replace(FORBIDDEN_CONTROLS, '');
  return ev.recurrenceId ? `${uid}${EXCEPTION_KEY_SEPARATOR}${ev.recurrenceId.replace(FORBIDDEN_CONTROLS, '')}` : uid;
}

/**
 * Shapes a parsed ICS event into a calendar_events upsert row tied to a feed.
 * The (feed_id, external_uid) pair is the upsert conflict target, so re-syncing
 * a changed public calendar updates rows in place instead of duplicating them.
 *
 * Known limit, stated: AN IMPORTED SERIES IS STEPPED ON THE FAMILY'S CLOCK, NOT
 * ITS PUBLISHER'S. The DTSTART's TZID decides the series' first instant
 * (lib/sync/ics.ts, RFC 5545 §3.3.5 on a DST night), and then the row keeps
 * only that instant and the frequency: no column carries the source TZID, so
 * every later occurrence is expanded on the family's wall clock
 * (lib/calendar/recurrence.ts). For a feed published in the family's own zone
 * that is the same thing. For one published elsewhere — a weekly 09:00
 * America/New_York class followed from Europe/London — the occurrences between
 * the two zones' DST changes are an hour off the publisher's (the United
 * States moves its clocks two to three weeks before Europe in spring and one
 * week after it in autumn). The fix is a column for the source zone and an
 * expander that steps on it; until then the limit is said here, in the 0490
 * migration's header and in docs/PENDING_PROD_MIGRATIONS.md.
 */
export function mapIcsEventToRow(ev: IcsEvent, familyId: string, feedId: string): FeedEventRow {
  return {
    family_id: familyId,
    feed_id: feedId,
    external_uid: feedExternalUid(ev),
    title: ev.title || 'Untitled',
    description: ev.description ?? null,
    location: ev.location ?? null,
    starts_at: ev.startsAt,
    ends_at: ev.endsAt ?? null,
    all_day: ev.allDay ?? false,
    recurrence: icsRruleToRecurrence(ev.recurrenceRule),
    category: 'general',
  };
}

export type FeedRowPlan = {
  /** The rows to upsert: every live event, one per `external_uid`. */
  rows: FeedEventRow[];
  /**
   * Exact `external_uid`s the source says are CANCELLED (STATUS:CANCELLED) and
   * that name ONE row: a cancelled exception of a series that is itself still
   * live. Removed from the family's calendar if an earlier sync imported them.
   */
  cancelled: string[];
  /**
   * The bare UIDs of cancelled series masters — a cancelled VEVENT with no
   * RECURRENCE-ID. Each names the WHOLE series: the master's own row and every
   * exception's, `uid` and each `uid␟recurrenceId`, whether published in this
   * snapshot or imported by an earlier sync. The sync resolves those keys
   * against what it has stored (`seriesKeys`); the plan cannot name rows it
   * has never seen. Review on #908: the first cut named only the bare UID, the
   * removal matched exact keys, and a cancelled series left its moved
   * occurrences on the calendar for good.
   */
  cancelledSeries: string[];
};

/**
 * What a sync should write and what it should remove, from parsed ICS events.
 *
 * Keyed by `feedExternalUid`, last write wins per key: a feed that repeats a
 * UID is still upserted cleanly, and a series master and its exceptions are
 * DIFFERENT keys, so neither replaces the other. Before this, "last write wins
 * per UID" let a rescheduled occurrence — the last VEVENT with that UID in
 * most exports — overwrite the weekly master with a one-off at the new time,
 * and the whole series vanished from the family calendar. A cancelled event is
 * not a row; it is a removal — of one row for a cancelled exception, of the
 * whole series for a cancelled master, whichever order the publisher wrote
 * them in: an exception published beside its cancelled master is not a row,
 * and a cancelled exception of a cancelled series is not a removal of its own.
 *
 * A cancellation may carry only its identity — UID, and RECURRENCE-ID for one
 * occurrence — with no DTSTART or SUMMARY (RFC 5546 §3.2.5); the sync parses
 * with `bareCancellations` so such a component reaches the plan, and the plan
 * does not ask a cancellation for a start.
 *
 * Known limit, stated: the app's recurrence model has no exception dates, so
 * the master still renders the ORIGINAL slot of a moved or cancelled
 * occurrence alongside the exception. That is a duplicate on one week, where
 * the previous behaviour lost the series or the exception outright.
 */
export function planFeedRows(events: IcsEvent[], familyId: string, feedId: string): FeedRowPlan {
  const live = new Map<string, FeedEventRow>();
  const cancelled = new Set<string>();
  const cancelledMasters = new Set<string>();
  for (const ev of events) {
    if (!ev.uid) continue;
    // A cancellation needs only its identity (RFC 5546 §3.2.5 lets a CANCEL
    // omit DTSTART); a live event with no start cannot be placed and is skipped.
    if (ev.status !== 'cancelled' && !ev.startsAt) continue;
    const key = feedExternalUid(ev);
    if (ev.status === 'cancelled') {
      live.delete(key);
      (ev.recurrenceId ? cancelled : cancelledMasters).add(key);
      continue;
    }
    cancelled.delete(key);
    cancelledMasters.delete(key);
    live.set(key, mapIcsEventToRow(ev, familyId, feedId));
  }
  for (const uid of cancelledMasters) {
    const prefix = `${uid}${EXCEPTION_KEY_SEPARATOR}`;
    for (const key of [...live.keys()]) if (key.startsWith(prefix)) live.delete(key);
    for (const key of [...cancelled]) if (key.startsWith(prefix)) cancelled.delete(key);
  }
  return { rows: [...live.values()], cancelled: [...cancelled], cancelledSeries: [...cancelledMasters] };
}

/**
 * Of the keys a feed has stored, the ones that belong to a cancelled series:
 * the master's own (`uid`) and each exception's (`uid␟recurrenceId`). The
 * separator cannot occur in a stored UID (`feedExternalUid` strips it), so the
 * first one splits a key into its UID and its RECURRENCE-ID, and a stand-alone
 * event whose UID merely begins with the series' UID is not matched. Exact
 * keys, for an exact `.in()` removal: a UID may carry LIKE's own wildcards
 * (`%`, `_`), so a pattern match on a prefix is not safe against it.
 */
export function seriesKeys(storedKeys: Iterable<string>, cancelledSeries: readonly string[]): string[] {
  const series = new Set(cancelledSeries);
  const matched: string[] = [];
  for (const key of storedKeys) {
    const at = key.indexOf(EXCEPTION_KEY_SEPARATOR);
    if (series.has(at === -1 ? key : key.slice(0, at))) matched.push(key);
  }
  return matched;
}

/** The rows half of `planFeedRows`, for callers that only write. */
export function buildFeedRows(events: IcsEvent[], familyId: string, feedId: string): FeedEventRow[] {
  return planFeedRows(events, familyId, feedId).rows;
}

/**
 * What the calendar panel says after "Add & Sync Now" succeeds. When the URL
 * was one the family already subscribed to, addCalendarFeed re-synced that
 * subscription instead of adding one and did not apply the name or colour
 * typed on this add, so "Added" would describe a row the list does not show;
 * name the subscription it actually synced instead.
 */
export function feedAddedMessage(
  res: { imported?: number; alreadySubscribedAs?: string },
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (res.alreadySubscribedAs != null) return t('calendarSync.alreadySubscribedResynced', { name: res.alreadySubscribedAs });
  return res.imported != null ? `Added — ${res.imported} events imported` : 'Calendar added';
}
