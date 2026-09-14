// A feature gate with a key the catalog does not contain is not a gate.
//
// `resolveFeatureEntitlement` is explicit and deliberate about this:
//
//     const tier = byHref[href];
//     if (tier === undefined) return { allowed: true, planLevel };
//
// An unknown href is NOT GATED, so that routes predating the catalog keep
// working. The consequence is that a typo, a rename, or a page built against a
// route the catalog never learned about produces a gate that reads correctly,
// type-checks, passes review — and admits everybody.
//
// Two did. `/dashboard/vacations` and `/dashboard/weekend` were gated at 21 call
// sites between them and neither href was in `FEATURE_CATALOG`; the catalog had
// `/dashboard/trips`, a different route. So the whole 13-tab vacation workspace
// and the weekend planner were free to every family on every plan, the sidebar
// rendered both as unlocked links (it decides locked/unlocked from the resolved
// tier, not from `minLevel`), and `/api/vacations/ai` and `/api/weekend/discover`
// — a model call and a Ticketmaster/SeatGeek fan-out on the deployment's own
// keys — were open to Free.
//
// `tests/route-plan-gate.test.ts` could not catch it: its table-driven half
// asserts the gate's SOURCE TEXT (`expect(source).toContain('refuseUnlessEntitled(')`),
// which proves the line was typed, not that it refuses anyone. It is green on
// all three of the routes above.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FEATURE_CATALOG } from '../lib/constants/feature-catalog';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile', 'tests', 'scripts', 'e2e', '.claude']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** The four ways a gate is asked, each taking the href as a string literal. */
const GATE_CALLS = [
  /\brequireFeature\(\s*'([^']+)'/g,
  /\brefuseUnlessEntitled\(\s*[^,]+,\s*[^,]+,\s*\[([^\]]+)\]/g,
  /\bfamilyHasFeature\(\s*[^,]+,\s*[^,]+,\s*'([^']+)'/g,
  /\bresolveFeatureEntitlement\(\s*[^,]+,\s*[^,]+,\s*'([^']+)'/g,
];

type Use = { href: string; file: string; line: number };

const uses: Use[] = [];
for (const file of ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d)))) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of GATE_CALLS) {
    for (const m of text.matchAll(pattern)) {
      // refuseUnlessEntitled takes an ARRAY of hrefs; the others take one.
      for (const href of m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) {
        if (!href.startsWith('/')) continue;
        uses.push({ href, file: relative(ROOT, file), line: text.slice(0, m.index).split('\n').length });
      }
    }
  }
}

const catalogHrefs = new Set(FEATURE_CATALOG.map((f) => f.href).filter((h): h is string => !!h));

describe('every feature gate names a feature the catalog knows', () => {
  it('found gate call sites to check', () => {
    // A sweep that matches nothing passes forever. There are ~80 distinct keys.
    expect(new Set(uses.map((u) => u.href)).size).toBeGreaterThan(40);
  });

  it('never gates on an href the catalog does not contain', () => {
    const orphans = [...new Map(
      uses.filter((u) => !catalogHrefs.has(u.href)).map((u) => [`${u.href}|${u.file}`, u]),
    ).values()]
      .map((u) => `${u.file}:${u.line} gates on "${u.href}", which is not in FEATURE_CATALOG — so it admits everybody`);
    expect(orphans).toEqual([]);
  });

  // The two this was written for, named — so losing either row fails with the
  // feature rather than with a count.
  it.each(['/dashboard/vacations', '/dashboard/weekend', '/dashboard/trips', '/dashboard/assistant'])(
    'the catalog knows %s',
    (href) => { expect(catalogHrefs.has(href)).toBe(true); },
  );

  // The other direction is NOT asserted, deliberately: a catalog entry with no
  // gate is a feature an admin can tier that nothing enforces yet, which is a
  // different (and weaker) claim than a gate that cannot fire. Recording the
  // count keeps it visible without failing on it.
  it('reports catalog entries no gate references, without failing on them', () => {
    const used = new Set(uses.map((u) => u.href));
    const ungated = [...catalogHrefs].filter((h) => !used.has(h));
    expect(Array.isArray(ungated)).toBe(true);
    if (ungated.length) console.info(`[feature-catalog] ${ungated.length} catalog hrefs are not referenced by any gate call`);
  });
});
