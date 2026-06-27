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

export type CalendarContext = 'family' | 'personal' | 'work';

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
  context: CalendarContext;
  assignee_id: string | null;
}

/** Owner tagging applied to every event a feed imports (its person + lens). */
export type FeedOwner = { context?: CalendarContext | null; memberId?: string | null };

/**
 * Shapes a parsed ICS event into a calendar_events upsert row tied to a feed.
 * The (feed_id, external_uid) pair is the upsert conflict target, so re-syncing
 * a changed public calendar updates rows in place instead of duplicating them.
 * `owner` stamps the feed's person + context onto every event so a synced "Work"
 * calendar shows up as that member's work events.
 */
export function mapIcsEventToRow(ev: IcsEvent, familyId: string, feedId: string, owner: FeedOwner = {}): FeedEventRow {
  return {
    family_id: familyId,
    feed_id: feedId,
    external_uid: ev.uid,
    title: ev.title || 'Untitled',
    description: ev.description ?? null,
    location: ev.location ?? null,
    starts_at: ev.startsAt,
    ends_at: ev.endsAt ?? null,
    all_day: ev.allDay ?? false,
    recurrence: icsRruleToRecurrence(ev.recurrenceRule),
    category: 'general',
    context: owner.context ?? 'family',
    assignee_id: owner.memberId ?? null,
  };
}

/** Builds dedup'd upsert rows from parsed ICS events (last write wins per UID). */
export function buildFeedRows(events: IcsEvent[], familyId: string, feedId: string, owner: FeedOwner = {}): FeedEventRow[] {
  const byUid = new Map<string, FeedEventRow>();
  for (const ev of events) {
    if (!ev.uid || !ev.startsAt) continue;
    byUid.set(ev.uid, mapIcsEventToRow(ev, familyId, feedId, owner));
  }
  return [...byUid.values()];
}
