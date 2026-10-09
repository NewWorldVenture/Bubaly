// lib/relationship/calendar.ts — pure mapping from a relationship date to a
// family calendar event, so anniversaries/birthdays/date nights can show up on
// the calendar everyone already looks at. Recurring dates become yearly events.

import type { Database } from '@/lib/database.types';
import { validDay } from '@/lib/onboarding/ics-time';
import type { RelKind } from '@/lib/relationship/dates';

type CalendarInsert = Database['public']['Tables']['calendar_events']['Insert'];

export type CalendarSourceDate = {
  kind: RelKind;
  title: string;
  eventDate: string;        // 'YYYY-MM-DD'
  recursAnnually: boolean;
  location?: string | null;
};

/**
 * Build the calendar_events insert payload for a relationship date. All-day by
 * design (we track a day, not a time); recurring dates map to a yearly event so
 * they appear every year; birthdays use the birthday category.
 */
export function buildCalendarEventForDate(d: CalendarSourceDate, familyId: string, userId: string | null): CalendarInsert {
  if (!validDay(d.eventDate)) throw new RangeError('Invalid relationship date');
  const startsAt = `${d.eventDate}T00:00:00.000Z`;
  const endsAt = new Date(Date.parse(startsAt) + 86_400_000).toISOString();
  if (!validDay(endsAt.slice(0, 10))) throw new RangeError('Relationship date exceeds calendar bounds');
  return {
    family_id: familyId,
    created_by: userId,
    title: d.title,
    category: d.kind === 'birthday' ? 'birthday' : 'general',
    // All-day DATE storage uses UTC civil midnight and an exclusive next day.
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: true,
    recurrence: d.recursAnnually ? 'yearly' : 'none',
    location: d.location ?? null,
  };
}
