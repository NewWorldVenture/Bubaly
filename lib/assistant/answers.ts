// lib/assistant/answers.ts
//
// Turning family data into something a speaker can say. PURE — the caller does
// the reading, this does the wording, so every phrasing rule below is testable
// without a database.
//
// Written for the ear, not the eye. A screen can show eight rows and let
// someone skim; a speaker reads them in order and the listener has forgotten
// the first by the fourth. So the answers here are short, lead with the count,
// and name at most a few items.
import { boundSpeech, speakList, toSpeakable } from './intent';

export type AgendaEvent = {
  title: string;
  starts_at: string;
  all_day: boolean;
};

export type AgendaTask = {
  title: string;
  due_date: string | null;
};

/** How many items to name before falling back to "and N more". */
export const SPOKEN_ITEM_LIMIT = 3;

/** The clock reading in a family's own zone — "3pm", "10:30am". */
export function speakTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  });
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  const meridiem = (parts.dayPeriod ?? '').toLowerCase();
  // "3pm" rather than "3:00 PM": a speech engine reads the :00 aloud as
  // "three o'clock zero zero" on some devices, and nobody says it.
  const minutes = parts.minute === '00' ? '' : `:${parts.minute}`;
  return `${parts.hour}${minutes}${meridiem}`;
}

function nameItems(titles: readonly string[]): string {
  const shown = titles.slice(0, SPOKEN_ITEM_LIMIT);
  const rest = titles.length - shown.length;
  const named = speakList(shown);
  if (rest <= 0) return named;
  return `${named}, and ${rest} more`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** "You have three things today: …" */
export function agendaSpeech(
  events: readonly AgendaEvent[],
  day: 'today' | 'tomorrow',
  timezone: string,
): string {
  if (events.length === 0) {
    return boundSpeech(day === 'today'
      ? 'Nothing is on the calendar for today.'
      : 'Nothing is on the calendar for tomorrow.');
  }
  const titles = events.map((event) => {
    const title = toSpeakable(event.title);
    if (event.all_day) return title;
    const time = speakTime(event.starts_at, timezone);
    return time ? `${title} at ${time}` : title;
  });
  const count = events.length;
  return boundSpeech(
    `You have ${count} ${plural(count, 'thing', 'things')} ${day}: ${nameItems(titles)}.`,
  );
}

/** The single next item, which is the question people actually ask most. */
export function nextSpeech(events: readonly AgendaEvent[], timezone: string): string {
  const upcoming = events[0];
  if (!upcoming) return boundSpeech('Nothing else is scheduled today.');
  const title = toSpeakable(upcoming.title);
  if (upcoming.all_day) return boundSpeech(`Next up today: ${title}.`);
  const time = speakTime(upcoming.starts_at, timezone);
  return boundSpeech(time ? `Next up: ${title} at ${time}.` : `Next up: ${title}.`);
}

/**
 * The forgetting check: what is due and not done.
 *
 * Deliberately answers "nothing" as good news rather than silence. An assistant
 * that says nothing back is indistinguishable from one that failed, and the
 * whole value of asking is the reassurance when the answer is no.
 */
export function forgettingSpeech(tasks: readonly AgendaTask[], todayKey: string): string {
  const overdue = tasks.filter((task) => task.due_date && task.due_date < todayKey);
  const dueToday = tasks.filter((task) => task.due_date === todayKey);
  if (overdue.length === 0 && dueToday.length === 0) {
    return boundSpeech('Nothing is overdue and nothing is due today. You are on top of it.');
  }
  const sentences: string[] = [];
  if (overdue.length > 0) {
    sentences.push(
      `${overdue.length} ${plural(overdue.length, 'thing is', 'things are')} overdue: `
      + `${nameItems(overdue.map((task) => task.title))}.`,
    );
  }
  if (dueToday.length > 0) {
    sentences.push(
      `${dueToday.length} ${plural(dueToday.length, 'is', 'are')} due today: `
      + `${nameItems(dueToday.map((task) => task.title))}.`,
    );
  }
  return boundSpeech(sentences.join(' '));
}

/** What a link without the 'capture' scope hears when it tries to save. */
export const CAPTURE_NOT_ALLOWED_SPEECH = toSpeakable(
  'This assistant can read your day but is not allowed to add things. '
  + 'You can change that in Bubaly under Settings, Assistants.',
);

/** What any link hears when something genuinely broke on our side. */
export const ERROR_SPEECH = toSpeakable(
  'Something went wrong on my side, so I have not changed anything. Please try again in a moment.',
);
