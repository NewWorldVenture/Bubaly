// Voice command routing — pure, unit-tested. Turns a spoken transcript into a
// capture kind (task / note / event / shopping) so the Voice module can save it
// through the existing capture pipeline. Reuses the capture NL parser and layers
// voice-specific phrasing on top (wake words, "remind me to", "add X to the
// shopping list", "note that…").

import { suggestKind, parseEvent, parseDueDate, type CaptureKind } from '@/lib/capture/parse';
import { cleanTranscript } from '@/lib/voice/transcript';
import { asWallClockIn, instantForLocalTime } from '@/lib/time/zoned';

/** Leading filler/wake phrases people say before the real command. */
const WAKE_PREFIXES = [
  'hey bubaly', 'ok bubaly', 'okay bubaly', 'bubaly',
  'hey', 'ok', 'okay', 'please', 'can you', 'could you', 'would you',
  'i want to', 'i want you to', 'i need you to',
];

/** Strip a leading wake word / politeness so parsing sees the real command. */
export function stripWakeWords(raw: string): string {
  let text = (raw ?? '').trim();
  // Peel prefixes repeatedly (e.g. "hey, okay please add milk").
  let changed = true;
  while (changed) {
    changed = false;
    const lower = text.toLowerCase();
    for (const p of WAKE_PREFIXES) {
      if (lower === p) { text = ''; changed = true; break; }
      if (lower.startsWith(p + ' ') || lower.startsWith(p + ', ') || lower.startsWith(p + ',')) {
        text = text.slice(text.toLowerCase().indexOf(p) + p.length).replace(/^[\s,]+/, '');
        changed = true;
        break;
      }
    }
  }
  return text;
}

// Explicit voice intents that beat the generic heuristic. Order matters: the
// first pattern that matches wins. `strip` can carry the global flag to peel
// phrasing off BOTH ends (e.g. leading "add" + trailing "to the shopping list").
//
// `namesTheKind` marks a phrase where the person SAID which kind they wanted, so
// it outranks the date/time heuristic below. "Remind me to call the dentist
// tomorrow" is a reminder that happens to carry a day — not a calendar entry —
// and reading "tomorrow" as the stronger signal produced an event titled
// "Remind me to call the dentist tomorrow", command phrasing and all.
//
// The bare "add/buy/pick up/need" rule deliberately does NOT name the kind: it
// is a guess that the person meant shopping, and a concrete date and time is a
// better guess than that ("add dentist tomorrow at 3pm" is an appointment).
const INTENT_RULES: { re: RegExp; kind: CaptureKind; strip?: RegExp; namesTheKind: boolean }[] = [
  { re: /\b(add|put|get)\b.*\b(shopping|grocery|groceries)( list)?\b/i, kind: 'shopping', namesTheKind: true,
    strip: /^(add|put|get)\s+|\s*\bto\s+(the\s+)?(shopping|grocery|groceries)(\s+list)?\s*$/gi },
  { re: /^(add|buy|pick up|need)\b/i, kind: 'shopping', namesTheKind: false, strip: /^(add|buy|pick up|need)\s+/i },
  // "remind me NOT to forget the passports" is the same request as "remind me
  // to renew the passports", said the way people actually say it. Without the
  // optional negation and the "forget" it carries, the whole sentence became
  // the title.
  { re: /^(remind me (?:not )?to(?: forget)?|i need to|i have to|don'?t forget to|todo|to-do)\b/i, kind: 'task', namesTheKind: true,
    strip: /^(remind me (?:not )?to(?: forget(?: about)?)?|i need to|i have to|don'?t forget to|todo|to-do)\s+/i },
  { re: /^(note that|note|remember that|remember|jot down|write down)\b/i, kind: 'note', namesTheKind: true, strip: /^(note that|note|remember that|remember|jot down|write down)\s+/i },
  // "put IT on the calendar", "put THIS on my calendar" — the pronoun is how the
  // phrase is actually spoken, and requiring "put on the calendar" contiguous
  // meant none of them matched.
  { re: /^(schedule|add an? event|put (?:it |this |that )?on (?:the|my) calendar|calendar)\b/i, kind: 'event', namesTheKind: true,
    strip: /^(schedule|add an? event|put (?:it |this |that )?on (?:the|my) calendar|calendar)\s+/i },
];

export type VoiceRoute = {
  /** Cleaned command text to save (wake words, intent verb and date phrase removed). */
  text: string;
  /** The capture kind the command routes to. */
  kind: CaptureKind;
  /** True when an explicit intent phrase decided the kind (vs. the heuristic). */
  explicit: boolean;
  /**
   * When the command named a date or time, the moment it resolved to. Events
   * only. Null when nothing was said — the caller decides what "no time given"
   * means rather than having `now` quietly substituted here.
   */
  startsAt: Date | null;
  /** A day was named but no clock time, so the event covers the whole day. */
  allDay: boolean;
  /** Local YYYY-MM-DD the task is due, when a day was named. Tasks only. */
  dueDate: string | null;
};

/**
 * Resolve the date half of a route once its kind is settled.
 *
 * `timezone` is what makes this correct off the browser. Everything in
 * `lib/capture/parse.ts` does its arithmetic with runtime-local getters
 * (`getHours`, `setDate`), which ARE the person's clock in a browser and are
 * UTC on a server. So a spoken "Friday at 4pm" reaching the assistant bridge
 * was resolving to 16:00 UTC — noon for a family in New York, and a different
 * DAY for anyone near their own midnight.
 *
 * Two steps fix it and neither changes the browser path, where `timezone` is
 * simply not passed: hand the parser the family's wall clock so "today" is
 * theirs, then map the wall-clock answer back to a real instant in their zone.
 */
function withDates(
  kind: CaptureKind, text: string, explicit: boolean, now: Date, timezone?: string,
): VoiceRoute {
  const clock = timezone ? asWallClockIn(now, timezone) : now;

  if (kind === 'event') {
    const parsed = parseEvent(text, clock);

    // No subject left once the date is taken out — "put it on the calendar
    // tomorrow at 6pm", where "it" refers to something Bubaly never heard.
    // parseEvent falls back to the raw input when its title strips to nothing,
    // so a title identical to the input after a MATCHED date means there was
    // never anything to call the event. Returning empty text routes this to
    // `unknown`, and the assistant asks — better than a calendar entry named
    // "Tomorrow at 6pm".
    if (parsed.matched && parsed.title.trim() === text.trim()) {
      return { text: '', kind, explicit, startsAt: null, allDay: false, dueDate: null };
    }

    let startsAt: Date | null = parsed.matched ? parsed.startsAt : null;
    if (startsAt && timezone) {
      // instantForLocalTime, not zonedLocalToInstant: on the spring-forward
      // morning the named time may not exist, and an appointment should move to
      // the first minute that does rather than vanish.
      startsAt = instantForLocalTime(
        startsAt.getFullYear(), startsAt.getMonth() + 1, startsAt.getDate(),
        startsAt.getHours() * 60 + startsAt.getMinutes(), timezone,
      );
    }
    return {
      text: cleanTranscript(parsed.matched ? parsed.title : text) || cleanTranscript(text),
      kind, explicit,
      startsAt,
      allDay: parsed.matched ? parsed.allDay : false,
      dueDate: null,
    };
  }
  if (kind === 'task') {
    // `dueDate` is a local YYYY-MM-DD, so getting the family's calendar right is
    // the whole job — there is no instant to convert.
    const parsed = parseDueDate(text, clock);
    return {
      text: cleanTranscript(parsed.title) || cleanTranscript(text),
      kind, explicit, startsAt: null, allDay: false, dueDate: parsed.dueDate,
    };
  }
  // Notes and shopping items carry no date of their own.
  return { text: cleanTranscript(text), kind, explicit, startsAt: null, allDay: false, dueDate: null };
}

/**
 * Classify a spoken command into a capture kind + cleaned text. Applies wake-word
 * stripping, explicit intent rules, then falls back to the shared `suggestKind`
 * heuristic (which also detects times → events, due dates → tasks).
 */
export function classifyVoiceCommand(
  raw: string, now: Date = new Date(), timezone?: string,
): VoiceRoute {
  const stripped = stripWakeWords(raw);
  const base = stripped.trim();
  if (!base) return { text: '', kind: 'note', explicit: false, startsAt: null, allDay: false, dueDate: null };

  const apply = (rule: (typeof INTENT_RULES)[number]) =>
    withDates(rule.kind, rule.strip ? base.replace(rule.strip, '').trim() || base : base, true, now, timezone);

  // 1. The person named the kind. Nothing outranks being told.
  const named = INTENT_RULES.find((rule) => rule.namesTheKind && rule.re.test(base));
  if (named) return apply(named);

  // 2. A concrete date+time is the next strongest signal, and beats the bare
  //    "add …" guess below ("add dentist tomorrow at 3pm" is an appointment).
  //    The hinting verb still gets peeled off the title: the person said "add"
  //    to mean "create one", not as part of what to call it, and an event named
  //    "Add dentist" is the command talking back at them.
  const hinted = INTENT_RULES.find((rule) => !rule.namesTheKind && rule.re.test(base));
  if (parseEvent(base, now).matched) {
    const withoutVerb = hinted?.strip ? base.replace(hinted.strip, '').trim() || base : base;
    return withDates('event', withoutVerb, false, now, timezone);
  }

  // 3. A verb that merely hints at a kind.
  if (hinted) return apply(hinted);

  // 4. Nothing said either way — the shared heuristic decides.
  return withDates(suggestKind(base, now), base, false, now, timezone);
}

const KIND_VERB: Record<CaptureKind, string> = {
  task: 'Added task',
  note: 'Saved note',
  event: 'Scheduled event',
  shopping: 'Added to shopping list',
};

/** Friendly past-tense confirmation for a routed command. */
export function describeRoute(kind: CaptureKind): string {
  return KIND_VERB[kind];
}
