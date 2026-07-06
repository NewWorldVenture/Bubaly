// lib/command-bar/route.ts — pure ranking for the universal ⌘K command bar.
//
// One natural-language input, three destinations, ranked so the obvious one is
// first and Enter always does something sensible:
//   • navigate — fuzzy-match the nav catalog ("bill" → Billing)
//   • capture  — the text looks like a command ("remind me to…", "add milk…"):
//                classify it into a task/note/event/shopping via the SAME engine
//                Voice Control uses (lib/voice/command-router → lib/capture/parse)
//   • assistant — always offered as a fallback ("Ask the assistant: …")
// No I/O here: the client renders these and performs the chosen action
// (router.push / saveCapture / assistant deep-link). Deterministic → unit-tested.

import { classifyVoiceCommand, describeRoute } from '@/lib/voice/command-router';
import { detectIntent, type FamilyIntent } from '@/lib/intent/detect';
import type { CaptureKind } from '@/lib/capture/parse';

export type CommandNavItem = { href: string; label: string };

export type CommandResult =
  | { kind: 'navigate'; href: string; label: string; score: number }
  | { kind: 'intent'; intent: FamilyIntent; href: string; label: string }
  | { kind: 'capture'; captureKind: CaptureKind; text: string; label: string; explicit: boolean }
  | { kind: 'assistant'; query: string; label: string };

const MAX_RESULTS = 8;

/** Cheap relevance score of `query` against a nav label. Higher = better; 0 = no match. */
export function navMatchScore(query: string, label: string): number {
  const q = query.trim().toLowerCase();
  const l = label.toLowerCase();
  if (!q) return 0;
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  // the query is longer than / mentions the label ("calendar sync issue" → Calendar)
  if (q.startsWith(l)) return 55;
  if (q.split(/\s+/).includes(l)) return 50;
  if (l.includes(q)) return 40;
  // subsequence (all query chars appear in order) — weakest signal
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

const isMultiWord = (q: string) => q.trim().split(/\s+/).length >= 2;

/**
 * Rank command-bar results for `query`. Returns [] for a blank query. Strong nav
 * matches lead; an EXPLICIT capture intent ("remind me to…") outranks weak nav
 * matches; a heuristic capture (multi-word only) sits lower; the assistant
 * fallback is always last so Enter is never a dead end.
 */
export function routeCommand(query: string, nav: CommandNavItem[], now: Date = new Date()): CommandResult[] {
  const q = query.trim();
  if (!q) return [];

  const scored = nav
    .map((n) => ({ n, s: navMatchScore(q, n.label) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.n.label.length - b.n.label.length);

  const strongNav = scored.filter((x) => x.s >= 60);
  const weakNav = scored.filter((x) => x.s < 60);
  const toNav = (x: { n: CommandNavItem; s: number }): CommandResult =>
    ({ kind: 'navigate', href: x.n.href, label: x.n.label, score: x.s });

  const route = classifyVoiceCommand(q, now);
  const captureText = route.text || q;
  const capture: CommandResult = {
    kind: 'capture', captureKind: route.kind, text: captureText, explicit: route.explicit,
    label: `${describeRoute(route.kind)}: “${captureText}”`,
  };
  const assistant: CommandResult = { kind: 'assistant', query: q, label: `Ask the assistant: “${q}”` };

  // A recognized goal ("should we…", "get ready for…") routes to the matching
  // reasoning engine. It outranks weak nav + the assistant fallback, but not an
  // exact nav hit or an explicit capture command.
  const intent = detectIntent(q);
  const intentResult: CommandResult | null = intent
    ? { kind: 'intent', intent: intent.intent, href: intent.href, label: intent.label }
    : null;

  const out: CommandResult[] = [];
  out.push(...strongNav.map(toNav));
  if (route.explicit) out.push(capture);
  if (intentResult) out.push(intentResult);
  out.push(...weakNav.map(toNav));
  if (!route.explicit && isMultiWord(q)) out.push(capture);
  out.push(assistant);

  // de-dupe navigate hrefs (a catalog can list the same href twice) and cap
  const seen = new Set<string>();
  return out
    .filter((r) => (r.kind === 'navigate' ? (seen.has(r.href) ? false : (seen.add(r.href), true)) : true))
    .slice(0, MAX_RESULTS);
}
