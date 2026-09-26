import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S9-17 — the same import-graph check the voice E2E spec runs, moved
 * where it is cheap.
 *
 * `tests/e2e/voice-capture-boundaries.spec.ts` mounts the real voice module in
 * a browser through a hand-rolled CommonJS loader. That loader throws
 * `Unexpected module <id>` for any import neither mocked nor listed in its
 * SOURCE_FILES, so a module that gains ONE import the harness does not provide
 * fails to mount and every test in the file dies on a textbox that never
 * rendered.
 *
 * The spec has its own first test for exactly this, which is how it was found —
 * but it only runs inside the 15-minute E2E job, and it cost a full CI cycle to
 * learn that extracting the voice-history write into `lib/voice/history.ts`
 * (C1-S8-06) had orphaned the harness. The walk itself needs no browser, no
 * server and no build: it is file reads and a regex. Running it here means the
 * next such extraction fails in seconds, in the suite a contributor runs before
 * pushing, instead of after a quarter of an hour of Playwright.
 *
 * This deliberately DUPLICATES the spec's check rather than replacing it. The
 * spec must keep its own copy: it is the thing that actually knows whether the
 * module mounts, and a guard that lives only over here would go stale the
 * moment the harness changed shape.
 */
const SPEC = 'tests/e2e/voice-capture-boundaries.spec.ts';
const spec = readFileSync(SPEC, 'utf8');

/** Read a `const NAME = [ ... ]` string-array literal out of the spec. */
function arrayLiteral(name: string): string[] {
  const start = spec.indexOf(`const ${name} = [`);
  expect(start, `${SPEC} no longer declares ${name}`).toBeGreaterThan(-1);
  const end = spec.indexOf('];', start);
  return [...spec.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The loader's id scheme: `@/x` and relative paths resolve to real files. */
function resolveAlias(specifier: string, importer: string): string | null {
  const base = specifier.startsWith('./') || specifier.startsWith('../')
    ? importer.slice(0, importer.lastIndexOf('/') + 1) + specifier.replace(/^\.\//, '')
    : specifier.startsWith('@/') ? specifier.slice(2) : null;
  if (base === null) return null;
  for (const ext of ['.ts', '.tsx']) if (existsSync(base + ext)) return base + ext;
  return null;
}

describe('the voice E2E harness provides every import the module reaches (C1-S9-17)', () => {
  it('walks the real graph and finds nothing missing', () => {
    const SOURCE_FILES = arrayLiteral('SOURCE_FILES');
    const MOCKED = arrayLiteral('MOCKED');
    const provided = new Set(SOURCE_FILES.map((f) => `@/${f.replace(/\.tsx?$/, '')}`));

    const queue = ['components/modules/voice-module.tsx'];
    const seen = new Set(queue);
    const missing: string[] = [];
    while (queue.length) {
      const file = queue.shift()!;
      const id = `@/${file.replace(/\.tsx?$/, '')}`;
      if (!provided.has(id) && !MOCKED.includes(id)) {
        missing.push(`${id}  (add '${file}' to SOURCE_FILES in ${SPEC}, or mock it)`);
        continue;
      }
      // A mocked id replaces the real module wholesale, so its imports are
      // never reached. Only follow what actually executes.
      if (!provided.has(id)) continue;
      // Value imports only: `import type` is erased and never reaches the loader.
      for (const match of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\s)[^;]*?from '([^']+)'/gm)) {
        const next = resolveAlias(match[1], file);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(missing, 'the voice E2E harness cannot load these').toEqual([]);
    // A walk that reaches almost nothing would report nothing missing. The
    // module's real graph is well over a dozen files; pin a floor so an
    // instrument that stopped walking cannot read as a clean result.
    expect(seen.size, 'the graph walk reached implausibly few files').toBeGreaterThan(12);
  });
});
