// The AI context deny-list, checked one hop further out than it was.
//
// `tests/context-policy.test.ts` asserts that no file under
// `lib/ai/context/slices` selects from a table on `SENSITIVE_TABLES`. That is
// the first hop, and the policy's own design puts the interesting part on the
// second: "slices call services, never these tables", with two narrow
// projections named as exceptions (allergies from a medical profile, a
// document's title). Nothing checked the services.
//
// It is not hypothetical. `lib/services/trips`'s `getTrip` reads
// `vacation_documents` — passport and ticket scans — and
// `vacation_emergency_contacts` with `select('*')`, and returns both on its
// snapshot. `lib/ai/context/slices/travel.ts` imports `listTrips`, which reads
// only `vacations`. Changing that one import to `getTrip` is a natural edit for
// a slice about trips, and it would put passport scans in a prompt while the
// existing static ratchet stayed green, because `travel.ts` would still contain
// no `.from('vacation_documents')`.
//
// So this resolves each slice's `@/lib/services/*` imports, computes which
// denied tables each imported function reaches (its own body, plus any
// same-module function it calls, to a fixpoint), and fails on a reach that the
// deny-list does not document as an exception.
//
// TWO ASSERTIONS EXIST TO STOP THIS PASSING VACUOUSLY, which is the defect class
// this repository has spent the most effort on. Writing it produced two parser
// bugs in a row, each of which made the answer zero:
//   * `export async function f(scope, input = {})` — taking the first `{` after
//     the name found the parameter default, so every body was `{}`;
//   * `): Promise<ServiceResult<{ link: X }>> {` — taking the first `{` after
//     the parameter list found the RETURN TYPE.
// Both were caught by the blind-spot check below rather than by noticing that a
// clean result was suspicious. Audit C1-S7-01.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SENSITIVE_TABLES } from '@/lib/ai/context/policy';

const ROOT = process.cwd();
const SLICES = join(ROOT, 'lib', 'ai', 'context', 'slices');

const DENIED = new Set(SENSITIVE_TABLES.map((t) => t.table));
/** table -> the one projection the policy says a service may surface. */
const DOCUMENTED = new Map(
  SENSITIVE_TABLES.filter((t) => t.except).map((t) => [t.table, t.except as string]),
);

const FROM = /\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g;
const EXPORTED_FN = /export (?:async )?function (\w+)\s*\(/g;

function tsFilesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith('.ts') ? [path] : [];
  return readdirSync(path).flatMap((entry) => tsFilesUnder(join(path, entry)));
}

function deniedTablesIn(source: string): Set<string> {
  return new Set([...source.matchAll(FROM)].map((m) => m[1]).filter((t) => DENIED.has(t)));
}

/** Exported function name -> body text. */
function functionBodies(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(EXPORTED_FN)) {
    // The regex ends just past the '(' that opens the parameter list.
    let i = match.index! + match[0].length;
    for (let depth = 1; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    // The body brace is the first '{' at angle-bracket depth zero — a return
    // type such as Promise<ServiceResult<{ link: X }>> carries braces of its own.
    let angle = 0;
    let open = -1;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '<') angle += 1;
      else if (c === '>') angle = Math.max(0, angle - 1);
      else if (c === '{' && angle === 0) { open = i; break; }
    }
    if (open < 0) continue;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '{') depth += 1;
      else if (source[close] === '}' && --depth === 0) break;
    }
    out.set(match[1], source.slice(open, close));
  }
  return out;
}

type ModuleAnalysis = {
  /** Exported function -> every denied table it reaches. */
  reaches: Map<string, Set<string>>;
  /** Denied tables the module reads that no function body accounts for. */
  blindSpots: Set<string>;
};

function analyseService(name: string): ModuleAnalysis {
  const files = tsFilesUnder(join(ROOT, 'lib', 'services', name));
  const bodies = new Map<string, string>();
  let whole = '';
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    whole += source;
    for (const [fn, body] of functionBodies(source)) bodies.set(fn, body);
  }

  const reaches = new Map<string, Set<string>>();
  for (const [fn, body] of bodies) reaches.set(fn, deniedTablesIn(body));

  // Fixpoint over same-module calls: a wrapper that returns what a reader read
  // reaches the same tables.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [fn, body] of bodies) {
      for (const other of bodies.keys()) {
        if (other === fn || !new RegExp(`\\b${other}\\s*\\(`).test(body)) continue;
        const before = reaches.get(fn)!.size;
        for (const table of reaches.get(other)!) reaches.get(fn)!.add(table);
        if (reaches.get(fn)!.size !== before) changed = true;
      }
    }
  }

  const attributed = new Set<string>();
  for (const tables of reaches.values()) for (const t of tables) attributed.add(t);
  const blindSpots = new Set([...deniedTablesIn(whole)].filter((t) => !attributed.has(t)));
  return { reaches, blindSpots };
}

const SERVICE_IMPORT = /import\s*\{([^}]+)\}\s*from\s*'@\/lib\/services\/([a-z-]+)'/g;

type Reach = { slice: string; service: string; fn: string; tables: string[] };

function measure(): { reaches: Reach[]; blindSpots: Map<string, string[]> } {
  const reaches: Reach[] = [];
  const blindSpots = new Map<string, string[]>();
  for (const file of readdirSync(SLICES).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(SLICES, file), 'utf8');
    for (const [, names, service] of source.matchAll(SERVICE_IMPORT)) {
      if (service === 'types') continue;
      const analysis = analyseService(service);
      if (analysis.blindSpots.size) blindSpots.set(service, [...analysis.blindSpots].sort());
      for (const raw of names.split(',')) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        const tables = analysis.reaches.get(fn);
        if (tables?.size) reaches.push({ slice: file, service, fn, tables: [...tables].sort() });
      }
    }
  }
  return { reaches, blindSpots };
}

describe('the context deny-list holds one hop out, through the services', () => {
  const { reaches, blindSpots } = measure();

  it('accounts for every denied table its services read', () => {
    // A parser that cannot see a read reports no violation. This is the
    // assertion that makes the zero below mean something.
    expect(Object.fromEntries(blindSpots)).toEqual({});
  });

  it('still finds the reaches the policy documents, so a clean run is not an empty one', () => {
    // Positive control. If a future refactor breaks the resolver, this fails
    // rather than the suite going quietly green on nothing.
    const documented = reaches
      .filter((r) => r.tables.every((t) => DOCUMENTED.has(t)))
      .map((r) => `${r.service}.${r.fn}`)
      .sort();
    expect(documented).toContain('documents.listDocuments');
    expect(documented).toContain('meals.foodProfile');
  });

  it('no slice reaches a denied table the policy does not document', () => {
    const undocumented = reaches
      .map((r) => ({ ...r, tables: r.tables.filter((t) => !DOCUMENTED.has(t)) }))
      .filter((r) => r.tables.length)
      .map((r) => `${r.slice} -> ${r.service}.${r.fn} -> ${r.tables.join(', ')}`)
      .sort();
    expect(undocumented).toEqual([]);
  });
});
