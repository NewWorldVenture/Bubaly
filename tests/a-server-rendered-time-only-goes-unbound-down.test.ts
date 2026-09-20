// A ratchet on server pages that print a time without saying whose time it is.
//
// The defect is measured in tests/a-server-rendered-time-is-the-familys-time.test.ts:
// a server component's formatter has no zone, so `Intl.DateTimeFormat` uses the
// RUNTIME's — UTC on Vercel — and a 09:00 Monday task for a family in Los Angeles
// renders "Today, 4:00 PM". `app/(app)/home/page.tsx` had already resolved the
// family zone to choose WHICH events were today and then printed them in the
// server's. The right events, at the wrong times.
//
// A ratchet and not a clean sweep, for the reason the sibling ratchet in
// tests/hardcoded-locales-only-go-down.test.ts gives: the honest floor is not
// zero today, and a guard that demands zero where zero is wrong is a guard
// somebody deletes. The nine that remain do not have the family's timezone in
// scope at all — converting them means adding a context read to each, which is a
// change per page and not a search-and-replace. Three did have it and are bound
// in this commit: home, command-center and planning.
//
// IT COUNTS THE CLOCK HELPERS ONLY, and that is the most important line here.
//
// The first version of this scan also counted `fmtDate`, and it was wrong in a
// way that mattered: `fmtDate` is what a page calls on a DATE column, and a DATE
// is the family's own day with no instant in it — binding a zone to one MOVES it
// (see DATE_ONLY in lib/utils/format.ts). `app/(app)/dashboard/family-cfo/page.tsx`
// is the case that exposed it. Its only time call is `fmtDate(b.due_date)`, so
// the coarse scan listed it as a defect, and "converting" it would have satisfied
// this ratchet while fixing nothing at all — the exact shape of a guard that can
// be met by going through the motions. `fmtTime`, `fmtDateTime`, `fmtRelative`
// and `fmtTimeAgo` render a clock, and nobody renders a clock for a DATE, so
// every one of them names an instant and every instant has a zone.
//
// WHAT IS EXCLUDED, and why, because an exclusion is where a ratchet goes quietly
// wrong:
//
//   'use client' entries — the runtime there IS the reader's machine, so the
//   runtime's zone is the right answer. This is the same reason `timeZone` is
//   optional on `createFormat` rather than required.
//
//   app/(marketing)/** — a published-at time has no family to be wrong about.
//
//   app/(app)/admin/** — staff surfaces, where a UTC audit-log timestamp is
//   defensible and arguably correct. Reported in the failure message rather than
//   silently dropped, so the exclusion cannot quietly grow.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The ceiling, derived rather than observed — and the derivation is why it is 9
 * and not 17.
 *
 * 55 server route entries format a timestamp inline, which was the first number
 * and the wrong one. Restricting to the CLOCK helpers, for the reason in the
 * header, leaves 12 family-facing entries, plus one admin. Three of the twelve
 * already resolved `family.timezone` for their reads and are bound here — home,
 * command-center and planning — so 9 remain.
 *
 * The 8 pages the coarse count lost are not conversions and must not be claimed
 * as any: they format DATE columns, which were never wrong.
 */
const CEILING = 9;

const ENTRY = /app\/.*\/(page|layout|template|default)\.tsx$/;
/** Clock helpers only — `fmtDate` is deliberately absent. See the header. */
const FORMATS_A_TIME = /\bfmt(Relative|TimeAgo|DateTime|Time)\s*\(/;
/** `getFormat(tz)` binds a zone; `getFormat()` does not. The argument is the fix. */
const BINDS_A_ZONE = /getFormat\(\s*[A-Za-z_$]/;

/**
 * Comments stripped first, and the sibling ratchet learned this the hard way:
 * the header of the module that CLOSED a site quotes the defect to explain it, so
 * a scan that reads comments counts the explanation as an occurrence and deleting
 * the explanation "converts" the file. This header quotes `fmtTime(` more than
 * once for exactly that reason.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const isClient = (raw: string) => /^\s*['"]use client['"]/m.test(raw.slice(0, 400));

function survey() {
  const files = execSync("git ls-files 'app/**/*.tsx'", { encoding: 'utf8' })
    .split('\n').filter((f) => f && ENTRY.test(f));
  const out = { unbound: [] as string[], bound: [] as string[], admin: 0, marketing: 0, entries: 0 };
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    if (isClient(raw)) continue;
    out.entries += 1;
    const source = withoutComments(raw);
    if (!FORMATS_A_TIME.test(source)) continue;
    if (file.startsWith('app/(marketing)')) { out.marketing += 1; continue; }
    if (file.includes('/admin/')) { out.admin += 1; continue; }
    (BINDS_A_ZONE.test(source) ? out.bound : out.unbound).push(file);
  }
  return out;
}

describe('a server-rendered time only goes unbound down', () => {
  it(`leaves at most ${CEILING} family-facing server pages printing the server's time`, () => {
    const s = survey();
    expect(s.unbound.length, [
      `${s.unbound.length} family-facing server route entries format a timestamp with no zone bound; ceiling ${CEILING}.`,
      `(${s.bound.length} bound · ${s.admin} admin and ${s.marketing} marketing excluded by design — see the header.)`,
      s.unbound.length > CEILING
        ? 'A change ADDED one. Resolve the family zone the page already needs for its reads — '
          + '`const tz = ctx.active.family.timezone || \'UTC\'` — and bind the formatter to it with '
          + '`await getFormat(tz)`. If the surface genuinely has no family, it belongs in one of the '
          + 'documented exclusions, not under the ceiling.'
        : `Converted ${CEILING - s.unbound.length}. Lower CEILING to ${s.unbound.length} in this commit.`,
      ...s.unbound.map((f) => `  ${f}`),
    ].join('\n')).toBeLessThanOrEqual(CEILING);
  });

  // Positive control, and the reason this ratchet is not self-certifying.
  //
  // The ceiling is met at 17 rather than at 0, so a survey that had gone blind —
  // a renamed helper, a changed entry glob, a regex that stopped matching — would
  // report 0 and PASS, more comfortably than the truth does. These plant each
  // shape and require it to be seen.
  it('recognises an unbound formatter, and a bound one', () => {
    for (const line of ['fmtTime(e.starts_at)', 'fmtDateTime(x)',
                        'fmtRelative(l.at)', 'fmtTimeAgo(t)']) {
      expect(FORMATS_A_TIME.test(line), line).toBe(true);
    }
    // And a NEGATIVE control on the same regex, which is the half that keeps the
    // scope honest: `fmtDate` on a DATE column is not a defect, so a scan that
    // starts matching it again has widened back into counting correct code.
    expect(FORMATS_A_TIME.test('fmtDate(b.due_date)'),
      'fmtDate is matching again — this ratchet is counting DATE columns as defects').toBe(false);
    expect(BINDS_A_ZONE.test('const { fmtTime } = await getFormat(tz);')).toBe(true);
    expect(BINDS_A_ZONE.test('const { fmtMoney } = await getFormat();')).toBe(false);
    for (const p of ['app/(app)/home/page.tsx', 'app/(app)/dashboard/x/layout.tsx']) {
      expect(ENTRY.test(p), p).toBe(true);
    }
    expect(ENTRY.test('app/(app)/home/parts.tsx')).toBe(false);
  });

  // Non-vacuity floor on the survey itself. Every number above is a count, and a
  // count of zero is what a broken walk returns. `app/(app)/home/page.tsx` is
  // converted in this commit, so it must appear on the BOUND side — if it stops
  // doing so, either the fix was reverted or the scan can no longer see it, and
  // the ceiling assertion above cannot tell those apart from success.
  it('actually walked the tree', () => {
    const s = survey();
    expect(s.entries, 'no server route entries were found at all').toBeGreaterThan(100);
    expect(s.bound, 'the page this ratchet was written for is not on the bound side')
      .toContain('app/(app)/home/page.tsx');
    // All three bound pages, not just one: each was bound by a different route —
    // home already called getFormat(), the other two had to be moved off the bare
    // exports — and a scan that sees only one of them is seeing a coincidence.
    for (const bound of ['app/(app)/dashboard/command-center/page.tsx',
                         'app/(app)/dashboard/planning/page.tsx']) {
      expect(s.bound, `${bound} was bound in this commit and the scan cannot see it`).toContain(bound);
    }
  });
});
