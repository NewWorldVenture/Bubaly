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
 * one occurrence — is stored under `uid#recurrenceId`, so it never overwrites
 * the series it belongs to and the series never overwrites it.
 */
export function feedExternalUid(ev: Pick<IcsEvent, 'uid' | 'recurrenceId'>): string {
  return ev.recurrenceId ? `${ev.uid}#${ev.recurrenceId}` : ev.uid;
}

/**
 * Shapes a parsed ICS event into a calendar_events upsert row tied to a feed.
 * The (feed_id, external_uid) pair is the upsert conflict target, so re-syncing
 * a changed public calendar updates rows in place instead of duplicating them.
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
   * The `external_uid`s the source says are CANCELLED (STATUS:CANCELLED), to be
   * removed from the family's calendar if an earlier sync imported them. A
   * cancelled series master names the whole series; a cancelled exception
   * names that one occurrence.
   */
  cancelled: string[];
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
 * not a row; it is a removal.
 *
 * Known limit, stated: the app's recurrence model has no exception dates, so
 * the master still renders the ORIGINAL slot of a moved or cancelled
 * occurrence alongside the exception. That is a duplicate on one week, where
 * the previous behaviour lost the series or the exception outright.
 */
export function planFeedRows(events: IcsEvent[], familyId: string, feedId: string): FeedRowPlan {
  const live = new Map<string, FeedEventRow>();
  const cancelled = new Set<string>();
  for (const ev of events) {
    if (!ev.uid || !ev.startsAt) continue;
    const key = feedExternalUid(ev);
    if (ev.status === 'cancelled') {
      live.delete(key);
      cancelled.add(key);
      continue;
    }
    cancelled.delete(key);
    live.set(key, mapIcsEventToRow(ev, familyId, feedId));
  }
  return { rows: [...live.values()], cancelled: [...cancelled] };
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
