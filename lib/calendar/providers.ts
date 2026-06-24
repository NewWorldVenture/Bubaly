// Calendar provider presets + "add to calendar" deep-links.
// Pure (no deps) so it's unit-tested and importable anywhere. Powers the
// super-simple "connect any calendar" UX: each provider tells the user exactly
// where to find its ICS/subscribe URL (inbound), and we generate one-click
// subscribe links so other apps can follow the Bubaly feed (outbound).

export type CalendarConnect = 'oauth' | 'ics';

export type CalendarProvider = {
  id: string;
  label: string;
  icon: string;        // emoji (kept dependency-free; swap for brand SVG later)
  /** Tailwind classes for the card accent. */
  accent: string;
  connect: CalendarConnect;
  /** OAuth initiation route (two-way), when connect === 'oauth'. */
  connectUrl?: string;
  /** Step-by-step: where to find this provider's ICS / subscribe URL. */
  steps: string[];
  placeholder: string;
};

export const CALENDAR_PROVIDERS: CalendarProvider[] = [
  {
    id: 'google', label: 'Google Calendar', icon: '🗓️', accent: 'text-blue-300 bg-blue-500/15',
    connect: 'oauth', connectUrl: '/api/sync/google/auth',
    steps: [
      'Tap “Connect Google” for instant two-way sync (recommended).',
      'Or, for read-only: Google Calendar → Settings → your calendar → “Secret address in iCal format”.',
    ],
    placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
  },
  {
    id: 'apple', label: 'Apple / iCloud', icon: '🍎', accent: 'text-slate-200 bg-slate-500/15',
    connect: 'ics',
    steps: [
      'On iCloud.com Calendar, click the broadcast icon next to a calendar.',
      'Enable “Public Calendar” and copy the webcal:// link.',
    ],
    placeholder: 'webcal://p##-caldav.icloud.com/published/…',
  },
  {
    id: 'microsoft', label: 'Outlook / Microsoft 365', icon: '📅', accent: 'text-sky-300 bg-sky-500/15',
    connect: 'ics',
    steps: [
      'Outlook → Calendar → Settings → Shared calendars.',
      'Under “Publish a calendar”, publish it and copy the ICS link.',
    ],
    placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
  },
  {
    id: 'schoology', label: 'Schoology', icon: '🎓', accent: 'text-violet-300 bg-violet-500/15',
    connect: 'ics',
    steps: [
      'Schoology → Calendar (left menu).',
      'Click the iCal feed icon (bottom-right) and copy the feed URL.',
    ],
    placeholder: 'https://app.schoology.com/calendar/feed/ical/…',
  },
  {
    id: 'classroom', label: 'Google Classroom', icon: '📚', accent: 'text-emerald-300 bg-emerald-500/15',
    connect: 'ics',
    steps: [
      'Classroom adds a calendar to your Google Calendar automatically.',
      'In Google Calendar → that class → Settings → “Secret address in iCal format”.',
    ],
    placeholder: 'https://calendar.google.com/calendar/ical/…classroom…/basic.ics',
  },
  {
    id: 'canvas', label: 'Canvas', icon: '🖌️', accent: 'text-rose-300 bg-rose-500/15',
    connect: 'ics',
    steps: [
      'Canvas → Calendar.',
      'Click “Calendar Feed” (bottom-right) and copy the link.',
    ],
    placeholder: 'https://canvas.instructure.com/feeds/calendars/…ics',
  },
  {
    id: 'teamsnap', label: 'TeamSnap', icon: '⚽', accent: 'text-amber-300 bg-amber-500/15',
    connect: 'ics',
    steps: [
      'TeamSnap → Schedule tab.',
      'Tap “Subscribe / WebCal” and copy the calendar link.',
    ],
    placeholder: 'webcal://teamsnap.com/…/schedule.ics',
  },
  {
    id: 'ics', label: 'Any other calendar', icon: '🔗', accent: 'text-cyan-300 bg-cyan-500/15',
    connect: 'ics',
    steps: ['Find the calendar’s public ICS or webcal:// link and paste it below.'],
    placeholder: 'https://…/calendar.ics',
  },
];

export function getCalendarProvider(id: string): CalendarProvider | undefined {
  return CALENDAR_PROVIDERS.find((p) => p.id === id);
}

/** Convert an http(s) ICS URL to a webcal:// URL (opens native calendar apps). */
export function webcalUrl(url: string): string {
  return url.replace(/^https?:\/\//i, 'webcal://');
}

/** Convert webcal:// back to https:// for providers that need a fetchable URL. */
export function httpsUrl(url: string): string {
  return url.replace(/^webcal:\/\//i, 'https://');
}

export type AddToCalendarLinks = { google: string; outlook: string; apple: string };

/**
 * One-click subscribe links so OTHER apps can follow the Bubaly feed (outbound).
 * `feedUrl` is Bubaly's published ICS URL (https).
 */
export function addToCalendarLinks(feedUrl: string): AddToCalendarLinks {
  const https = httpsUrl(feedUrl);
  const webcal = webcalUrl(https);
  return {
    google: `https://calendar.google.com/calendar/r/settings/addbyurl?url=${encodeURIComponent(https)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent('Bubaly')}`,
    apple: webcal,
  };
}
