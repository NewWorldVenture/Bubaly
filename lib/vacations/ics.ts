// Build a standards-compliant iCalendar (.ics) feed for trips. Importable into
// Google Calendar, Apple Calendar, and Outlook — our cross-platform calendar
// integration. Pure + unit-tested.

export type IcsEvent = {
  uid: string;
  title: string;
  start: string;        // YYYY-MM-DD (all-day)
  end?: string | null;  // YYYY-MM-DD inclusive last day
  location?: string | null;
  description?: string | null;
};

const fold = (line: string) => line; // (kept simple; lines are short)
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const ymd = (d: string) => d.replace(/-/g, '');

const DAY = 86_400_000;

/**
 * DTEND for all-day events is exclusive, so add one day to the inclusive end.
 *
 * `IcsEvent.start`/`.end` are DATE values — the family's calendar days, straight
 * out of the `vacations.start_date`/`end_date` DATE columns — not instants, so
 * the step happens entirely in UTC and the day comes back exactly as it went in.
 * The previous anchor was LOCAL midnight (`new Date(ymdDate + 'T00:00:00')`),
 * stepped with `setDate`, then read back with `toISOString()`, which re-expresses
 * that local moment at Greenwich: east of Greenwich the day slid one back (local
 * midnight 8 Jul in Tokyo is 7 Jul 15:00Z), so a 1-7 Jul trip exported
 * DTEND 20260707 and every importing calendar — Google, Apple, Outlook — dropped
 * the last day of the trip. At or west of Greenwich it landed on the right day,
 * which is why CI (UTC and America/Los_Angeles) never saw it. UTC days are always
 * exactly 24h, so stepping by DAY here is DST-proof too.
 */
function nextDay(ymdDate: string): string {
  return new Date(Date.parse(ymdDate + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
}

export function buildICS(events: IcsEvent[], calName = 'Bubaly Vacations'): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bubaly//Vacation Planner//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calName)}`,
  ];
  for (const e of events) {
    if (!e.start) continue;
    const endExclusive = nextDay(e.end || e.start);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${esc(e.uid)}@bubaly.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.start)}`,
      `DTEND;VALUE=DATE:${ymd(endExclusive)}`,
      fold(`SUMMARY:${esc(e.title)}`),
    );
    if (e.location) lines.push(fold(`LOCATION:${esc(e.location)}`));
    if (e.description) lines.push(fold(`DESCRIPTION:${esc(e.description)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
