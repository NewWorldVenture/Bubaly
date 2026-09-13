// lib/assistant/intent.ts
//
// What did the person actually ask for, and what should the assistant say back?
//
// Pure and unit-tested. Two jobs, both of which have to be right before any
// database work is worth doing:
//
//   1. Classify an utterance. Assistants hand over a raw transcript, so this
//      has to cope with the way people actually speak to them — wake words,
//      politeness, and the fact that "what's on today" and "add milk" want
//      completely different things.
//
//   2. Produce SPEAKABLE text. Everything here is read aloud by a device, which
//      changes what good output looks like: no markdown, no bullet characters,
//      no URLs, no "1/3" that a speech engine reads as "one slash three", and
//      short enough that a person can hold it in their head. A screen can be
//      skimmed; speech cannot be.
import { classifyVoiceCommand, type VoiceRoute } from '@/lib/voice/command-router';

export type AssistantIntentKind =
  /** Read out what is on, today or tomorrow. */
  | 'agenda'
  /** The single next thing. */
  | 'next'
  /** The proactive "what am I forgetting" check. */
  | 'forgetting'
  /** Read a list back: the shopping list, the to-do list. */
  | 'list'
  /** Save something: task, note, event or shopping item. */
  | 'capture'
  /** Tell the person what they can say. */
  | 'help'
  /** Understood as speech, not as a command. */
  | 'unknown';

export type AssistantIntent =
  | { kind: 'agenda'; day: 'today' | 'tomorrow' }
  | { kind: 'next' }
  | { kind: 'forgetting' }
  | { kind: 'list'; list: 'shopping' | 'tasks' }
  | { kind: 'capture'; route: VoiceRoute }
  | { kind: 'help' }
  | { kind: 'unknown'; utterance: string };

/** Asking about the day. Checked before capture: "what's on" is not a to-do. */
const AGENDA_RE = /\b(what(?:'?s| is| are)?\s+(on|up|happening|planned|scheduled)|agenda|schedule|calendar|plans?)\b/i;
const TOMORROW_RE = /\btomorrow\b/i;
const NEXT_RE = /\b(what(?:'?s| is)?\s+next|next up|coming up next|what do i do now)\b/i;
const FORGETTING_RE = /\b(forget|forgetting|missing|miss(ed)?\s+anything|overlook)/i;
const HELP_RE = /\b(help|what can (you|i) (do|say)|how does this work|commands?)\b/i;

/**
 * Reading a list back.
 *
 * Bubaly could be told to put milk ON the shopping list and had no way to say
 * what was on it — which is half a feature, and the missing half is the one you
 * want standing in a shop.
 *
 * Two conditions, both required. A list NOUN, because "what do we need" is not
 * specific enough to answer without guessing which list; and a READ cue,
 * because "milk for the shopping list" names a list while plainly asking for
 * something to be added to it.
 */
const SHOPPING_LIST_RE = /\b(shopping|grocery|groceries)\s+list\b/i;
const TASK_LIST_RE = /\b(to-?\s?dos?|todos?|tasks?)\s+list\b|\bto-?do\s+list\b/i;
const LIST_READ_RE = /\b(what(?:'?s| is| are)?\s+(?:on|in|left|still)|read|tell me|say|check)\b/i;

/**
 * Openers that mean "do this". When an utterance starts with one, the words
 * after it are the THING, not a question about it — so none of the question
 * matchers above get a say.
 *
 * Without this, each question matcher is a trap for a perfectly ordinary
 * command, because the words overlap:
 *
 *   "schedule the school play on Tuesday"   -> AGENDA_RE     ("schedule")
 *   "remind me to help with the homework"   -> HELP_RE       ("help")
 *   "remind me not to forget the passports" -> FORGETTING_RE ("forget")
 *   "put it on the calendar tomorrow"       -> AGENDA_RE     ("calendar")
 *
 * Each of those was heard as a question and answered instead of being saved,
 * which to the person is Bubaly ignoring them.
 */
const IMPERATIVE_RE = /^(add|put|get|buy|pick up|need|schedule|remind me|note|remember|jot|write)\b/i;

/**
 * Speech an assistant passes through when it heard nothing useful. Alexa sends
 * an empty slot rather than omitting it, so a blank string is a real case.
 */
function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

export function classifyAssistantUtterance(
  raw: string, now: Date = new Date(), timezone?: string,
): AssistantIntent {
  const utterance = (raw ?? '').trim();
  if (isBlank(utterance)) return { kind: 'help' };

  // Questions are matched before capture. Without this, "what's on today"
  // parses as an event ("today" is a date) and Bubaly would silently create a
  // calendar entry called "what's on" instead of answering.
  const commanded = IMPERATIVE_RE.test(utterance);
  if (!commanded) {
    // Most specific first. "What's on the shopping list" matches AGENDA_RE
    // ("what's on"), so anything less specific asked before it would read the
    // calendar and answer a question nobody asked.
    if (LIST_READ_RE.test(utterance)) {
      if (SHOPPING_LIST_RE.test(utterance)) return { kind: 'list', list: 'shopping' };
      if (TASK_LIST_RE.test(utterance)) return { kind: 'list', list: 'tasks' };
    }
    if (HELP_RE.test(utterance)) return { kind: 'help' };
    if (FORGETTING_RE.test(utterance)) return { kind: 'forgetting' };
    if (NEXT_RE.test(utterance)) return { kind: 'next' };
    if (AGENDA_RE.test(utterance)) {
      return { kind: 'agenda', day: TOMORROW_RE.test(utterance) ? 'tomorrow' : 'today' };
    }
  }

  const route = classifyVoiceCommand(utterance, now, timezone);
  if (isBlank(route.text)) return { kind: 'unknown', utterance };
  return { kind: 'capture', route };
}

// ---------------------------------------------------------------------------
// Speakable text
// ---------------------------------------------------------------------------

/** Longest reply worth speaking. Beyond this people stop listening. */
export const MAX_SPEECH_CHARS = 600;

/**
 * Strip everything a speech engine would mangle.
 *
 * Markdown, list bullets and URLs all read badly aloud: an asterisk becomes a
 * pause or a literal "star" depending on the device, and a URL is read out
 * character by character. Titles come from user data, so none of this can be
 * assumed away.
 */
export function toSpeakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, 'a link')
    // A slash between words or digits is read out as the word "slash", so
    // "Parent/teacher evening" becomes "parent slash teacher evening" and "1/3"
    // becomes "one slash three". The contract above has named this since the
    // module was written; the code never did it.
    .replace(/(?<=[\p{L}\p{N}])\s*\/\s*(?=[\p{L}\p{N}])/gu, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/^\s*[-•·]\s*/gm, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bound a value on its way to the DATABASE. Length only.
 *
 * The counterpart to `boundSpeech`, and the distinction matters: everything
 * `toSpeakable` removes is removed because a speech engine mangles it, which is
 * a fact about the speaker and not about the note. Storing the spoken form
 * meant "the garage code is #1234" was filed with the hash gone and
 * "Parent/teacher evening" would lose its slash — the family's own words
 * quietly edited to suit a device that had already finished talking.
 */
export function boundText(text: string, limit: number): string {
  const tidy = (text ?? '').replace(/\s+/g, ' ').trim();
  if (tidy.length <= limit) return tidy;
  const clipped = tidy.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.5 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

/** Join items the way a person would say them: "a, b and c". */
export function speakList(items: readonly string[]): string {
  const clean = items.map(toSpeakable).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/** Cut at a sentence end if possible, so speech never stops mid-word. */
export function boundSpeech(text: string, limit = MAX_SPEECH_CHARS): string {
  const speakable = toSpeakable(text);
  if (speakable.length <= limit) return speakable;
  const clipped = speakable.slice(0, limit);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  if (lastStop > limit * 0.5) return clipped.slice(0, lastStop + 1).trim();
  return `${clipped.slice(0, clipped.lastIndexOf(' ')).trim()}…`;
}

export const HELP_SPEECH = toSpeakable(
  'You can ask what is on today, what is next, what you are forgetting, '
  + 'or what is on the shopping list. '
  + 'You can also say things like add milk to the shopping list, or remind me to call the dentist.',
);

/** What to say when the words arrived but meant nothing actionable. */
export function unknownSpeech(utterance: string): string {
  const heard = boundSpeech(utterance, 80);
  return heard
    ? `I heard "${heard}", but I am not sure what to do with it. ${HELP_SPEECH}`
    : HELP_SPEECH;
}

/**
 * A date said out loud: "Saturday", "Saturday at 4pm", "the 3rd of October".
 *
 * Weekday-relative for the coming week because that is how people hold dates in
 * their head, and a bare date for anything further out. No year, no "2026-09-19"
 * — a speech engine reads that as a subtraction.
 */
function speakableDate(instant: Date, timezone: string, withTime: boolean, now: Date): string {
  const zone = timezone || 'UTC';
  const days = Math.round((instant.getTime() - now.getTime()) / 86_400_000);
  const dayPart = days >= 0 && days <= 6
    ? new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(instant)
    : new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'long' }).format(instant);
  if (!withTime) return dayPart;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(instant)
    .replace(':00', '')       // "4:00 pm" is read back as "four zero zero"
    .replace(/\s?([ap])m/i, '$1m');
  return `${dayPart} at ${time}`;
}

/**
 * Confirmation after saving something, naming what it became AND when.
 *
 * The when matters more here than anywhere else in the app: there is no screen
 * to glance at, so the spoken confirmation is the only chance a person gets to
 * catch "Friday" being heard as "Thursday" before they find out by missing it.
 */
export function captureSpeech(route: VoiceRoute, timezone = 'UTC', now: Date = new Date()): string {
  const what = boundSpeech(route.text, 120);
  switch (route.kind) {
    case 'shopping': return `Added ${what} to the shopping list.`;
    case 'task': return route.dueDate
      ? `Added a task: ${what}, due ${speakableDate(new Date(`${route.dueDate}T12:00:00Z`), timezone, false, now)}.`
      : `Added a task: ${what}.`;
    case 'event': return route.startsAt
      ? `Added ${what} to the calendar for ${speakableDate(route.startsAt, timezone, !route.allDay, now)}.`
      : `Added ${what} to the calendar.`;
    case 'note': return `Noted: ${what}.`;
    default: return `Saved ${what}.`;
  }
}
