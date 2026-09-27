import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A THIRD spelling of "the host's day", which neither existing guard can see.
 *
 * tests/server-midnight-is-not-the-familys-midnight.test.ts catches two:
 * `setHours(0, 0, 0, 0)` and `new Date().toISOString().slice(0, 10)`. Both look
 * for a host-day expression written out in the file. This one has no such
 * expression to find — it is a call to a helper that ALREADY KNOWS how to do
 * the right thing, made without the argument that tells it whose day to use:
 *
 *     parseEvent(q, now)              // resolves against LOCAL_OPS, the host
 *     classifyVoiceCommand(q, now)    // its `timezone` parameter left empty
 *
 * That was Q21. `lib/ai/context/intents.ts` did exactly this and then
 * serialised the resolved instant onto the calendar, so "dentist tomorrow at
 * 3pm" was booked a day late. `lib/voice/command-router.ts` carries a long
 * header explaining precisely how to avoid it, and the call site did not read
 * it. The machinery was built, documented, and not reached.
 *
 * It was found by reading code, not by a guard — which is the point of adding
 * this one. A defect class that two instruments are blind to will come back.
 *
 * What this guard CANNOT see, stated so nobody mistakes it for proof: it
 * checks call ARITY, not whether the value passed is defined. A call site that
 * passes `input.timezone` where that property is optional satisfies this guard
 * and can still be `undefined` at runtime. Arity is the part a parser can
 * settle; the rest needs types, and `lib/home/home-brief.ts` says so at the
 * field itself.
 *
 * Scope is deliberately narrow: SERVER-reachable modules only. In a browser
 * these same helpers are correct with no zone, because there `new Date()` is
 * the person's own clock and "tomorrow at 6pm" means 6pm where they are
 * standing — the deliberate half of lib/capture/parse.ts's LOCAL/UTC split.
 */

// Helpers that resolve a wall clock, and the argument position that carries the
// zone. Fewer arguments than that means the zone was not passed.
const ZONE_AWARE: { name: string; zoneArgIndex: number; how: string }[] = [
  { name: 'parseEvent', zoneArgIndex: 2, how: "pass `{ utc: true }` with a UTC-anchored clock (see withDates in lib/voice/command-router.ts)" },
  { name: 'parseDueDate', zoneArgIndex: 2, how: "pass `{ utc: true }` with a UTC-anchored clock" },
  { name: 'classifyVoiceCommand', zoneArgIndex: 2, how: 'pass the family timezone as the third argument' },
  // ── The ones that DEFAULT to 'UTC' rather than to the host ────────────────
  //
  // Found by sweeping every exported function in app/ and lib/ for a parameter
  // named tz/timezone/zone that is optional or defaulted. Six came back, and
  // every current caller of every one of them passes the zone — so this half of
  // the list fixes nothing today and exists only to keep it that way.
  //
  // Their defaults are NOT removed, and that is deliberate. Each is a contract
  // someone wrote on purpose and pinned with a test — "retains explicit UTC
  // default" (tests/first-brief-week-window.test.ts), "keeps the original UTC
  // schedule and payload exactly when timezone is omitted"
  // (tests/onboarding-ics.test.ts), and the `const { timezone, ...legacy }`
  // assertion in tests/first-brief-callers-timezone.test.ts. Deleting a
  // deliberate, tested contract in order to fix zero defects is not a trade
  // worth making; guarding the call sites is.
  //
  // Defaulting to 'UTC' is in one way WORSE than defaulting to the host: the
  // host is at least sometimes the family, whereas a hardcoded UTC is wrong for
  // every household outside it, silently and permanently.
  { name: 'buildFirstBrief', zoneArgIndex: 3, how: "pass the family timezone as the fourth argument (it defaults to 'UTC')" },
  { name: 'captureSpeech', zoneArgIndex: 1, how: "pass the family timezone as the second argument (it defaults to 'UTC')" },
  { name: 'demoBriefEvents', zoneArgIndex: 1, how: "pass the family timezone as the second argument (it defaults to 'UTC')" },
  { name: 'classifyAssistantUtterance', zoneArgIndex: 2, how: 'pass the family timezone as the third argument' },
];

const ROOTS = ['app', 'lib'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * A module that can run on the server: `server-only`, `'use server'`, or a
 * Next route handler / server action file.
 *
 * The path check is anchored to `app/` on purpose, and that anchor is a bug
 * this guard had on its FIRST run. Matching `route.ts` anywhere accused
 * `lib/command-bar/route.ts` — which is not a route handler at all but a
 * library file that happens to carry the name, imported only by two CLIENT
 * components, where `classifyVoiceCommand` with no zone is the correct call.
 *
 * Worth leaving written down: a guard whose first finding is a false
 * accusation is worse than no guard, because the next person "fixes" working
 * code. Anything outside `app/` must say it is server-side to be judged here.
 */
function isServerReachable(file: string, source: string): boolean {
  if (/^\s*import\s+['"]server-only['"]/m.test(source)) return true;
  if (/^\s*['"]use server['"]/m.test(source)) return true;
  if (/^\s*['"]use client['"]/m.test(source)) return false;
  const normalised = file.replace(/\\/g, '/');
  return /^app\//.test(normalised)
    && (/\/route\.tsx?$/.test(normalised) || /\/actions\.tsx?$/.test(normalised));
}

type Offence = { file: string; line: number; callee: string; args: number; how: string };

/**
 * A PARSER, not a regex. Counting call arguments with a regex is how an earlier
 * pass of this audit produced 128 matches where the real number was 70 — nested
 * calls, object literals and template strings all contain commas.
 */
function scan(file: string): Offence[] {
  const source = readFileSync(file, 'utf8');
  if (!isServerReachable(file, source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Offence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const spec = ZONE_AWARE.find((z) => z.name === node.expression.getText());
      // A spread means the arguments are assembled elsewhere; this guard cannot
      // judge it, and saying nothing is better than a false accusation.
      const spread = node.arguments.some(ts.isSpreadElement);
      if (spec && !spread && node.arguments.length <= spec.zoneArgIndex) {
        found.push({
          file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          callee: spec.name, args: node.arguments.length, how: spec.how,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

describe('a zone-aware helper called without the zone', () => {
  it('never resolves a wall clock against the host in server-reachable code', () => {
    const offences = ROOTS.flatMap((root) => walk(root)).flatMap(scan);
    const report = offences
      .map((o) => `${o.file}:${o.line} — ${o.callee}() got ${o.args} args; ${o.how}`)
      .join('\n');
    expect(report).toBe('');
  });

  // Non-vacuity. A guard that cannot fail is the thing this audit keeps finding,
  // so the scanner is exercised against the defect as it actually shipped.
  it('catches the call shape that shipped', () => {
    const offences = ZONE_AWARE.map((z) => z.name);
    expect(offences).toContain('parseEvent');
    // The Q21 line, reconstructed: a server-only module calling parseEvent with
    // the two arguments it used to take.
    const sf = ts.createSourceFile(
      'synthetic.ts',
      "import 'server-only';\nconst event = parseEvent(q, now);\n",
      ts.ScriptTarget.Latest, true,
    );
    let hits = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.getText() === 'parseEvent' && node.arguments.length <= 2) hits++;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    expect(hits).toBe(1);
  });

  it('leaves the browser alone, where the device clock is the right answer', () => {
    expect(isServerReachable('components/app/quick-capture.tsx', "'use client';\nparseEvent(q, now);")).toBe(false);
    // The false positive this guard produced on its first run: a library file
    // named route.ts, imported only by client components.
    expect(isServerReachable('lib/command-bar/route.ts', 'export function routeCommand() {}')).toBe(false);
    // A real Next route handler still counts, with no directive needed.
    expect(isServerReachable('app/api/ai/chef/route.ts', 'export async function POST() {}')).toBe(true);
    expect(isServerReachable('app/(app)/dashboard/auto/actions.ts', "'use server';\n")).toBe(true);
  });
});
