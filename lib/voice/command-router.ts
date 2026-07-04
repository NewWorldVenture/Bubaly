// Voice command routing — pure, unit-tested. Turns a spoken transcript into a
// capture kind (task / note / event / shopping) so the Voice module can save it
// through the existing capture pipeline. Reuses the capture NL parser and layers
// voice-specific phrasing on top (wake words, "remind me to", "add X to the
// shopping list", "note that…").

import { suggestKind, parseEvent, type CaptureKind } from '@/lib/capture/parse';
import { cleanTranscript } from '@/lib/voice/transcript';

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

// Explicit voice intents that beat the generic heuristic. Order matters:
// the first pattern that matches wins. `strip` can carry the global flag to peel
// phrasing off BOTH ends (e.g. leading "add" + trailing "to the shopping list").
const INTENT_RULES: { re: RegExp; kind: CaptureKind; strip?: RegExp }[] = [
  { re: /\b(add|put|get)\b.*\b(shopping|grocery|groceries)( list)?\b/i, kind: 'shopping',
    strip: /^(add|put|get)\s+|\s*\bto\s+(the\s+)?(shopping|grocery|groceries)(\s+list)?\s*$/gi },
  { re: /^(add|buy|pick up|need)\b/i, kind: 'shopping', strip: /^(add|buy|pick up|need)\s+/i },
  { re: /^(remind me to|i need to|i have to|don'?t forget to|todo|to-do)\b/i, kind: 'task', strip: /^(remind me to|i need to|i have to|don'?t forget to|todo|to-do)\s+/i },
  { re: /^(note that|note|remember that|remember|jot down|write down)\b/i, kind: 'note', strip: /^(note that|note|remember that|remember|jot down|write down)\s+/i },
  { re: /^(schedule|add an? event|put on (the|my) calendar|calendar)\b/i, kind: 'event', strip: /^(schedule|add an? event|put on (the|my) calendar|calendar)\s+/i },
];

export type VoiceRoute = {
  /** Cleaned command text to save (wake words + intent verb removed). */
  text: string;
  /** The capture kind the command routes to. */
  kind: CaptureKind;
  /** True when an explicit intent phrase decided the kind (vs. the heuristic). */
  explicit: boolean;
};

/**
 * Classify a spoken command into a capture kind + cleaned text. Applies wake-word
 * stripping, explicit intent rules, then falls back to the shared `suggestKind`
 * heuristic (which also detects times → events, due dates → tasks).
 */
export function classifyVoiceCommand(raw: string, now: Date = new Date()): VoiceRoute {
  const stripped = stripWakeWords(raw);
  const base = stripped.trim();
  if (!base) return { text: '', kind: 'note', explicit: false };

  // A concrete date+time in the command is the strongest signal — trust it as an
  // event even if a verb like "add" is present ("add dentist tomorrow at 3pm").
  if (parseEvent(base, now).matched) {
    return { text: cleanTranscript(base), kind: 'event', explicit: false };
  }

  for (const rule of INTENT_RULES) {
    if (rule.re.test(base)) {
      const text = cleanTranscript(rule.strip ? base.replace(rule.strip, '').trim() : base);
      return { text: text || cleanTranscript(base), kind: rule.kind, explicit: true };
    }
  }

  return { text: cleanTranscript(base), kind: suggestKind(base, now), explicit: false };
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
