// A page refuses; the endpoint behind it must refuse too.
//
// `tests/route-plan-gate.test.ts` pins twenty-one endpoints that were found
// this way, but it pins a LIST someone typed. A route added afterwards is not
// on that list, so it cannot fail it — and two were not: `/api/ai`, the whole
// assistant turn, and `/api/ai/insights`, which serves thirty module pages.
// Both checked for a session and nothing else while the pages in front of them
// are `requireFeature`-gated.
//
// So this file DERIVES the set instead. It walks each gated page's imports for
// the `/api/...` paths its components fetch, and fails on any route that no
// gate refuses. The same walk produces the kind → feature map the insights
// route uses, and fails if the checked-in map and the pages disagree.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { INSIGHT_FEATURE_HREFS } from '@/lib/ai/insight-features';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walkFiles(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/** Every string literal inside each `name(...)` call — the args, whatever their order. */
function callArgs(source: string, name: string): string[][] {
  const out: string[][] = [];
  for (const m of source.matchAll(new RegExp(`${name}\\(`, 'g'))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    out.push([...source.slice(m.index + m[0].length, i - 1).matchAll(/'([^']*)'/g)].map((s) => s[1]));
  }
  return out;
}

/**
 * The hrefs a page requires. Taken from the CALL ARGUMENTS rather than by
 * regex: `requireFeature` is called both as `requireFeature('/x')` and as
 * `requireFeature(ctx, '/x')`, and a pattern that assumes the second shape
 * matches past the end of the first one and invents hrefs that are not there.
 */
function pageHrefs(file: string): string[] {
  const hrefs = callArgs(read(file), 'requireFeature').flat().filter((a) => a.startsWith('/'));
  return [...new Set(hrefs)];
}

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
  else return null;
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(path.join(ROOT, base + ext))) return base + ext;
  }
  return null;
}

/** Collect from a file and everything it imports under app/ or components/. */
function walkImports<T>(file: string, collect: (src: string) => Set<T>, seen = new Set<string>()): Set<T> {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const source = read(file);
  const out = collect(source);
  for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const resolved = resolveImport(m[1], file);
    if (resolved && (resolved.startsWith('app/') || resolved.startsWith('components/'))) {
      for (const v of walkImports(resolved, collect, seen)) out.add(v);
    }
  }
  return out;
}

const INSIGHT_KINDS = new Set(
  [...read('lib/ai/insights.ts').matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1]),
);

const apiPaths = (src: string) => new Set(
  [...src.matchAll(/['"`](\/api\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1].split('?')[0].replace(/\/$/, '')),
);
const insightKinds = (src: string) => new Set(
  src.includes('AiInsight')
    ? [...src.matchAll(/kind=[{"']([a-z_]+)/g)].map((m) => m[1]).filter((k) => INSIGHT_KINDS.has(k))
    : [],
);

const GATED_PAGES = walkFiles('app/(app)')
  .filter((f) => f.endsWith('page.tsx'))
  .map((f) => ({ file: f, hrefs: pageHrefs(f) }))
  .filter((p) => p.hrefs.length > 0);

const TIER = new Map(FEATURE_CATALOG.filter((f) => f.href).map((f) => [f.href as string, f.defaultTier]));
const isPaid = (href: string) => TIER.get(href) === 'basic' || TIER.get(href) === 'plus';

// Any mechanism that refuses on the family's plan. Several routes resolve it by
// hand through a different helper, and counting only the shared one would
// report them as bypasses when they are not.
const GATE_MARKERS = [
  'refuseUnlessEntitled', 'assertAIAccess', 'resolveFeatureEntitlement',
  'requireFeature', 'effectivePlanLevel', 'featureAccessByTier',
];

describe('the pages are readable at all', () => {
  it('finds gated pages and insight kinds', () => {
    // If a refactor breaks the walk, every assertion below would pass vacuously.
    expect(GATED_PAGES.length).toBeGreaterThan(50);
    expect(INSIGHT_KINDS.size).toBeGreaterThan(40);
  });
});

describe('an endpoint behind a paid page refuses like the page', () => {
  const offenders = new Map<string, Set<string>>();
  for (const page of GATED_PAGES) {
    const paid = page.hrefs.filter(isPaid);
    if (paid.length === 0) continue;
    for (const api of walkImports(page.file, apiPaths)) {
      const routeFile = `app/api/${api.slice('/api/'.length)}/route.ts`;
      if (!existsSync(path.join(ROOT, routeFile))) continue;
      const source = read(routeFile);
      if (GATE_MARKERS.some((marker) => source.includes(marker))) continue;
      const set = offenders.get(api) ?? new Set<string>();
      for (const href of paid) set.add(href);
      offenders.set(api, set);
    }
  }

  // Push subscription management is reachable from a paid page and is
  // deliberately NOT gated: a family whose plan lapses must still be able to
  // unsubscribe a device, and none of these calls a model.
  const ALLOWED = new Set(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test']);

  it('leaves no ungated endpoint behind a paid feature', () => {
    const found = [...offenders.keys()].filter((api) => !ALLOWED.has(api)).sort();
    expect(found, `gate these with refuseUnlessEntitled:\n${found.join('\n')}`).toEqual([]);
  });

  it('still recognises the deliberate exceptions', () => {
    // If push stops being reachable from a paid page, this allowance is stale
    // and should be removed rather than left as a standing hole.
    expect([...offenders.keys()].some((api) => ALLOWED.has(api))).toBe(true);
  });
});

describe('the insight feature map matches the pages', () => {
  const derived = new Map<string, Set<string>>();
  for (const page of GATED_PAGES) {
    for (const kind of walkImports(page.file, insightKinds)) {
      const set = derived.get(kind) ?? new Set<string>();
      for (const href of page.hrefs) set.add(href);
      derived.set(kind, set);
    }
  }

  it('maps every kind rendered on a gated page, and no others', () => {
    expect(Object.keys(INSIGHT_FEATURE_HREFS).sort()).toEqual([...derived.keys()].sort());
  });

  it('gives each kind exactly the hrefs its pages require', () => {
    for (const [kind, hrefs] of derived) {
      expect([...(INSIGHT_FEATURE_HREFS[kind as keyof typeof INSIGHT_FEATURE_HREFS] ?? [])].sort())
        .toEqual([...hrefs].sort());
    }
  });

  it('covers the paid kinds — the ones a bypass was worth something for', () => {
    const paidKinds = [...derived.entries()].filter(([, hrefs]) => [...hrefs].some(isPaid));
    expect(paidKinds.length).toBeGreaterThan(20);
    for (const [kind] of paidKinds) expect(INSIGHT_FEATURE_HREFS).toHaveProperty(kind);
  });
});

describe('the gate runs before anything is spent', () => {
  it.each([
    ['app/api/ai/route.ts', '/dashboard/assistant'],
    ['app/api/ai/insights/route.ts', null],
  ])('%s gates before the rate limiter and the provider', (routeFile, href) => {
    const source = read(routeFile).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const gate = source.indexOf('refuseUnlessEntitled(');
    expect(gate).toBeGreaterThan(-1);
    if (href) expect(source).toContain(`'${href}'`);

    // Ordering is the point: a gate after the provider call refuses the family
    // and has already paid for the answer.
    for (const spent of ['resolveProvider(', 'enforceAIRateLimit(', 'rateLimitDb(']) {
      const at = source.indexOf(spent);
      if (at > -1) expect(gate).toBeLessThan(at);
    }
  });
});
