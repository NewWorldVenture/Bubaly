// lib/relationship/calendar.ts — pure mapping from a relationship date to a
// family calendar event, so anniversaries/birthdays/date nights can show up on
// the calendar everyone already looks at. Recurring dates become yearly events.

import type { Database } from '@/lib/database.types';
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
  return {
    family_id: familyId,
    created_by: userId,
    title: d.title,
    category: d.kind === 'birthday' ? 'birthday' : 'general',
    // Noon UTC keeps the calendar day stable across timezones for an all-day event.
    starts_at: `${d.eventDate}T12:00:00.000Z`,
    all_day: true,
    recurrence: d.recursAnnually ? 'yearly' : 'none',
    location: d.location ?? null,
  };
}
