// Pure activity-feed merge logic — unit tested, no dependencies.
// The feed is derived at read time from existing family tables; nothing is
// written. Each source contributes ActivityItems which are merged + sorted.

import { createFormat } from '@/lib/utils/format';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

export type ActivityKind = 'announcement' | 'event' | 'chore' | 'photo' | 'note' | 'grocery';

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  text: string;
  /** ISO timestamp the activity happened at. */
  at: string;
  /** Family member id, when the actor is known as a member. */
  memberId?: string | null;
  /** Auth user id, when the actor is only known by user id. */
  userId?: string | null;
};

/** Merge any number of source item arrays into one newest-first timeline. */
export function mergeActivity(sources: ActivityItem[][], limit = 50): ActivityItem[] {
  const all = sources.flat().filter((i) => i && i.at);
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, limit);
}

/** Human "2h ago" style relative time, stable and dependency-free. */
/**
 * "30m ago" for the reader, switching to a date past five weeks — which is where
 * this feed's own ladder switched, so en-US reads exactly as it did.
 */

export function relativeTime(iso: string, now: Date = new Date(), locale: LocaleCode = DEFAULT_LOCALE): string {
  return createFormat(locale).fmtTimeAgo(iso, { now, absoluteAfterDays: 35, absolutePattern: 'MMM d' });
}
