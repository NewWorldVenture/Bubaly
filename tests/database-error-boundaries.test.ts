import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A Supabase error message is written for whoever is holding the keys. Handing
// it to a caller leaks column names, constraint names, policy names and the
// shape of the schema — and tells the person nothing they can act on.
//
// ── what this file used to be (F-F13) ─────────────────────────────────────
//
// One `it` over a hand-written list of 27 route paths (two of them duplicated),
// containing three assertions, all of them `.not.toMatch`. Two ways to make it
// greener without fixing anything: delete a route from the list, or stop the
// route returning JSON errors at all. It asserted the absence of a bad string
// and nothing else, which is the F-F06 shape — a test satisfied by the removal
// of its own subject.
//
// It is now a scan with a positive half. The list is gone: every route under
// app/api is read, so a route added tomorrow is covered tomorrow, and the
// duplicates are moot.
const RAW_PROVIDER_MESSAGE = [
  /NextResponse\.json\(\s*\{[^\n]*\berror:\s*error\.message/,
  /(?:error|message|details):\s*(?:err|error|e)\??\.message/,
  /(?:error|message|details):\s*String\((?:err|error|e)\)/,
];

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (full.endsWith('route.ts')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

describe('API database error boundaries', () => {
  const routes = routeFiles('app/api').map((f) => [f, blankComments(readFileSync(f, 'utf8'))] as const);
  const answering = routes.filter(([, src]) => /NextResponse\.json\(/.test(src));

  it('reads every API route, not a list of them (non-vacuity)', () => {
    // The hand-written list this replaces held 27 paths, two of them the same
    // path twice. A scan cannot go stale, but it CAN silently stop matching —
    // so the counts are asserted, and they are the positive half's foundation.
    expect(routes.length).toBeGreaterThan(120);
    expect(answering.length).toBeGreaterThan(100);
  });

  // A response that cannot carry a provider message at all: a literal or
  // translated string, or a structured status with no message in it. Both are
  // leak-proof; the failure this file is about is a THIRD shape, where the
  // caught value itself becomes the response.
  const SAFE_MESSAGE = /error:\s*(?:t\(|tr\(|['"`])|errorResponse\(\s*['"`]|new NextResponse\(\s*['"`]|BodyError\(\s*\d+,\s*['"`]|reason:\s*['"`]/;
  const STRUCTURED_ONLY = /NextResponse\.json\(\s*\{\s*ok:\s*false/;
  // Two more shapes that carry nothing of the caught value: an empty body, and
  // a response built from a module constant (the Alexa route speaks a fixed
  // line rather than reading an error out loud).
  const NO_BODY = /new NextResponse\(\s*null/;
  const FIXED_CONSTANT = /\(\s*[A-Z][A-Z0-9_]{3,}\s*\)/;

  it('every route that catches builds its answer from something it wrote itself', () => {
    // The half the old file did not have. Its three `.not.toMatch` assertions
    // were equally satisfied by a route that stopped answering at all, which is
    // how a test comes to be greener for being emptier. This one gets HARDER as
    // routes are added.
    const catching = answering.filter(([, src]) => /catch\s*[({]/.test(src));
    const unaccounted = catching
      .filter(([, src]) => !SAFE_MESSAGE.test(src) && !STRUCTURED_ONLY.test(src)
        && !NO_BODY.test(src) && !FIXED_CONSTANT.test(src))
      .map(([f]) => f);
    expect(catching.length, 'the subject set must not be empty').toBeGreaterThan(90);
    expect(
      unaccounted,
      'these catch and answer, and the answer is neither a message they wrote nor a structured status:\n'
      + unaccounted.join('\n'),
    ).toEqual([]);
  });

  it('and none of them is the provider\'s own message', () => {
    const leaks: string[] = [];
    for (const [file, src] of answering) {
      for (const pattern of RAW_PROVIDER_MESSAGE) {
        if (pattern.test(src)) { leaks.push(`${file}  (${pattern.source.slice(0, 44)}…)`); break; }
      }
    }
    expect(
      leaks,
      'A Supabase message names columns, constraints and policies. Answer with something the caller\n'
      + 'can act on and log the real one:\n' + leaks.join('\n'),
    ).toEqual([]);
  });

  it('reads code, not the comments about it (sanity)', () => {
    const prose = blankComments('// never do error: error.message here\nconst x = 1;');
    expect(RAW_PROVIDER_MESSAGE.some((p) => p.test(prose))).toBe(false);
    expect(RAW_PROVIDER_MESSAGE.some((p) => p.test('return NextResponse.json({ error: error.message });'))).toBe(true);
    expect(RAW_PROVIDER_MESSAGE.some((p) => p.test('return NextResponse.json({ error: String(err) });'))).toBe(true);
    expect(RAW_PROVIDER_MESSAGE.some((p) => p.test("return NextResponse.json({ error: t('x.couldNotDoThat') });"))).toBe(false);
  });
});
