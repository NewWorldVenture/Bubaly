// lib/contacts/timeline.ts — the per-contact Relationship Timeline brain (pure,
// tested). Merges everything the family knows about one person — logged
// interactions (visit/call/gift/favor/note), communications from the inbox, and
// birthdays — into a single reverse-chronological timeline, then reasons over
// it: relationship health (how long since the last touch vs. the natural
// cadence of this relationship) and a plain-language reconnect suggestion.
// No Supabase / React imports.

export type InteractionKind = 'visit' | 'call' | 'message' | 'gift' | 'favor' | 'note';

export interface LoggedInteraction {
  id: string;
  kind: InteractionKind;
  occurred_on: string;           // YYYY-MM-DD
  title: string;
  note: string | null;
  amount: number | null;         // gift value etc. (dollars)
}

export interface CommunicationLike {
  id: string;
  channel: string;               // call | text | email | school…
  direction: string;             // inbound | outbound
  subject: string | null;
  summary: string | null;
  received_at: string;           // ISO
}

export type TimelineEntryKind = InteractionKind | 'communication' | 'birthday';

export interface TimelineEntry {
  id: string;
  kind: TimelineEntryKind;
  date: string;                  // YYYY-MM-DD
  title: string;
  detail: string | null;
  amount: number | null;
}

export interface ContactHealth {
  lastTouch: string | null;      // YYYY-MM-DD of the most recent touch
  daysSince: number | null;
  cadenceDays: number | null;    // median gap between touches (needs ≥3 touches)
  status: 'fresh' | 'due' | 'overdue' | 'no_history';
  suggestion: string;            // plain-language next step
}

const DAY = 86_400_000;

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function toDate(s: string): Date {
  return new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
}

/** Merge logged interactions + inbox communications (+ this year's birthday) into one timeline. */
export function buildContactTimeline(input: {
  interactions: LoggedInteraction[];
  communications: CommunicationLike[];
  birthdayMonth?: number | null;
  birthdayDay?: number | null;
  now?: Date;
}): TimelineEntry[] {
  const now = input.now ?? new Date();
  const entries: TimelineEntry[] = [];

  for (const i of input.interactions) {
    entries.push({
      id: `int-${i.id}`,
      kind: i.kind,
      date: i.occurred_on,
      title: i.title,
      detail: i.note,
      amount: i.amount,
    });
  }

  for (const c of input.communications) {
    entries.push({
      id: `comm-${c.id}`,
      kind: 'communication',
      date: ymd(toDate(c.received_at)),
      title: c.subject || `${c.direction === 'outbound' ? 'Reached out' : 'Heard from them'} · ${c.channel}`,
      detail: c.summary,
      amount: null,
    });
  }

  // This year's birthday (if it already happened) so the timeline shows it.
  if (input.birthdayMonth && input.birthdayDay) {
    const bd = new Date(Date.UTC(now.getUTCFullYear(), input.birthdayMonth - 1, input.birthdayDay));
    if (bd <= now) {
      entries.push({
        id: `bday-${now.getUTCFullYear()}`,
        kind: 'birthday',
        date: ymd(bd),
        title: 'Birthday 🎂',
        detail: null,
        amount: null,
      });
    }
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/** Median gap in days between consecutive touches (excludes birthdays). */
export function touchCadenceDays(entries: TimelineEntry[]): number | null {
  const touchDates = [...new Set(entries.filter((e) => e.kind !== 'birthday').map((e) => e.date))].sort();
  if (touchDates.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < touchDates.length; i++) {
    gaps.push(Math.round((toDate(touchDates[i]).getTime() - toDate(touchDates[i - 1]).getTime()) / DAY));
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

/** Relationship health from the timeline: fresh / due / overdue vs. the cadence. */
export function contactHealth(entries: TimelineEntry[], name: string, now: Date = new Date()): ContactHealth {
  const touches = entries.filter((e) => e.kind !== 'birthday');
  if (touches.length === 0) {
    return {
      lastTouch: null, daysSince: null, cadenceDays: null, status: 'no_history',
      suggestion: `No history with ${name} yet — log a visit or call to start the timeline.`,
    };
  }

  const lastTouch = touches.map((e) => e.date).sort().at(-1)!;
  const daysSince = Math.max(0, Math.round((now.getTime() - toDate(lastTouch).getTime()) / DAY));
  const cadenceDays = touchCadenceDays(entries);

  // Without a cadence baseline, use gentle defaults: due after 30d, overdue after 90d.
  const dueAt = cadenceDays ? Math.max(cadenceDays, 7) : 30;
  const overdueAt = cadenceDays ? Math.max(cadenceDays * 2, 14) : 90;

  let status: ContactHealth['status'] = 'fresh';
  if (daysSince >= overdueAt) status = 'overdue';
  else if (daysSince >= dueAt) status = 'due';

  const suggestion =
    status === 'fresh'
      ? `You're in good touch with ${name} — last contact ${daysSince === 0 ? 'today' : `${daysSince}d ago`}.`
      : status === 'due'
        ? `It's been ${daysSince} days — about time for a call or visit with ${name}.`
        : `It's been ${daysSince} days since you connected with ${name} — well past your usual rhythm. A quick call goes a long way.`;

  return { lastTouch, daysSince, cadenceDays, status, suggestion };
}

export const INTERACTION_LABEL: Record<InteractionKind, string> = {
  visit: 'Visit',
  call: 'Call',
  message: 'Message',
  gift: 'Gift',
  favor: 'Favor',
  note: 'Note',
};
