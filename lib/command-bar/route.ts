// lib/command-bar/route.ts — pure ranking for the universal ⌘K command bar.
//
// One natural-language input, three destinations, ranked so the obvious one is
// first and Enter always does something sensible:
//   • navigate — fuzzy-match the nav catalog ("bill" → Billing)
//   • record   — an actual household row the search service found
//                ("furnace warranty" → the warranty, not a page named that)
//   • capture  — the text looks like a command ("remind me to…", "add milk…"):
//                classify it into a task/note/event/shopping via the SAME engine
//                Voice Control uses (lib/voice/command-router → lib/capture/parse)
//   • search   — "see all results" on /dashboard/search
//   • assistant — always offered as a fallback ("Ask the assistant: …")
// No I/O here: the client renders these and performs the chosen action
// (router.push / saveCapture / assistant deep-link). Deterministic → unit-tested.
// Records are FETCHED by the caller (a debounced server action) and passed in,
// so this module stays pure and the ordering stays testable without a database.

import { classifyVoiceCommand, describeRoute } from '@/lib/voice/command-router';
import { detectIntent, type FamilyIntent } from '@/lib/intent/detect';
import type { CaptureKind } from '@/lib/capture/parse';
import type { SearchKind } from '@/lib/search/rank';

export type CommandNavItem = { href: string; label: string };

/** One household row the search service returned, ready to be offered in the bar. */
export type CommandRecord = {
  kind: SearchKind;
  id: string;
  title: string;
  href: string;
  /** The date the record is about, ISO; null when it has none. Rendered as evidence. */
  occurredAt: string | null;
  score: number;
};

export type CommandResult =
  | { kind: 'navigate'; href: string; label: string; score: number }
  | { kind: 'record'; recordKind: SearchKind; id: string; href: string; label: string; occurredAt: string | null; score: number }
  | { kind: 'intent'; intent: FamilyIntent; href: string; label: string }
  | { kind: 'capture'; captureKind: CaptureKind; text: string; label: string; explicit: boolean }
  | { kind: 'search'; query: string; href: string; label: string }
  | { kind: 'assistant'; query: string; label: string };

/** Hard cap on rows the bar offers, the assistant fallback included. */
export const MAX_RESULTS = 8;

/**
 * How many record hits the bar itself offers. The rest are one keystroke away
 * on /dashboard/search — a palette that fills with eleven warranties has
 * stopped being a command bar.
 */
export const MAX_RECORD_RESULTS = 4;

/** Below this the fan-out is not worth a round trip, and matches half the house. */
export const MIN_RECORD_QUERY = 3;

/** The results page for a query — the one place that shows everything, grouped. */
export function searchHref(query: string): string {
  return `/dashboard/search?q=${encodeURIComponent(query.trim())}`;
}

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
 * matches; household RECORDS sit below both and above weak nav, because a page
 * whose name you typed exactly is still what you meant; a heuristic capture
 * (multi-word only) sits lower; the assistant fallback is always last so Enter
 * is never a dead end.
 *
 * `records` are already ranked by `lib/search/rank`; this only decides where
 * the block goes and how many of it are shown.
 */
export function routeCommand(
  query: string,
  nav: CommandNavItem[],
  now: Date = new Date(),
  records: CommandRecord[] = [],
): CommandResult[] {
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

  const recordResults: CommandResult[] = records.slice(0, MAX_RECORD_RESULTS).map((r) => ({
    kind: 'record', recordKind: r.kind, id: r.id, href: r.href, label: r.title, occurredAt: r.occurredAt, score: r.score,
  }));

  const out: CommandResult[] = [];
  out.push(...strongNav.map(toNav));
  if (route.explicit) out.push(capture);
  out.push(...recordResults);
  if (intentResult) out.push(intentResult);
  out.push(...weakNav.map(toNav));
  if (!route.explicit && isMultiWord(q)) out.push(capture);
  // "See all results" is how /dashboard/search is reached at all — it is in no
  // sidebar, by design. Offered for any query long enough to have been searched,
  // whether or not this fetch came back with anything, and its slot is reserved
  // below so the cap cannot take it away again.
  if (q.length >= MIN_RECORD_QUERY) {
    out.push({ kind: 'search', query: q, href: searchHref(q), label: `See all results for “${q}”` });
  }

  // De-dupe navigate hrefs (a catalog can list the same href twice), then cap.
  //
  // The cap is applied to the NAV/capture/intent rows only. Records and the
  // "see all results" row get their slots reserved first, because capping the
  // whole list silently dropped both: a single word like "family" matches seven
  // entries in the real catalogue, which filled all eight slots on their own. A
  // household with a document called "Family insurance policy" would then have
  // the fetched hit discarded AND lose the only route to /dashboard/search —
  // exactly the "matches nav labels and nothing else" behaviour this replaced.
  //
  // The assistant fallback is appended after the cap rather than being one more
  // row that can be sliced off: Enter must never be a dead end.
  const isReserved = (r: CommandResult) => r.kind === 'record' || r.kind === 'search';
  const budget = MAX_RESULTS - 1; // the assistant fallback holds the last slot

  const seen = new Set<string>();
  const deduped = out.filter((r) =>
    r.kind === 'navigate' ? (seen.has(r.href) ? false : (seen.add(r.href), true)) : true);

  // Whatever the reserved rows do not use is spent on nav/capture/intent, in
  // their existing order — so the weakest of those (weak nav, then a heuristic
  // capture) are the rows that give way, and the ordering of the kinds is
  // unchanged from before records existed.
  let flexible = Math.max(0, budget - deduped.filter(isReserved).length);
  const body: CommandResult[] = [];
  for (const r of deduped) {
    if (isReserved(r)) body.push(r);
    else if (flexible > 0) { flexible -= 1; body.push(r); }
  }
  return [...body.slice(0, budget), assistant];
}
