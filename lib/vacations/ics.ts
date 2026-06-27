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

/** DTEND for all-day events is exclusive, so add one day to the inclusive end. */
function nextDay(ymdDate: string): string {
  const d = new Date(ymdDate + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
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
