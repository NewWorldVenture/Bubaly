// The medications E2E fixtures load the real module graph inside the page, from
// a hand-written list of files. Their loader throws `Unexpected fixture module`
// on anything missing, and because that happens while the harness is still
// building its probe, the whole spec file fails with `mount is not a function` —
// 43 tests red, and nothing in the message names the import that caused it.
//
// That is what a new import costs: `lib/medications/adherence.ts` started
// resolving dose slots in the family's zone, picked up `lib/time/zoned.ts`, and
// took both spec files down. tests/e2e/voice-capture-boundaries.spec.ts carries
// the same guard for its own fixture. This one runs in the fast suite, so the
// answer arrives in seconds rather than after the E2E job.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const SPECS = ['tests/e2e/medications-ledger.spec.ts', 'tests/e2e/medications-readback-review.spec.ts'];

/** The repo's `@/` alias and relative specifiers, to a real file or null. */
function resolveAlias(specifier: string, importer: string): string | null {
  const base = specifier.startsWith('./') || specifier.startsWith('../')
    ? normalize(join(dirname(importer), specifier))
    : specifier.startsWith('@/') ? specifier.slice(2) : null;
  if (base === null) return null;
  for (const extension of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
  }
  return null;
}

function listedSources(spec: string): string[] {
  const block = /Object\.fromEntries\(\s*\[([\s\S]*?)\]\s*\.map/.exec(readFileSync(spec, 'utf8'));
  expect(block, `${spec} no longer has a source list this guard can read`).not.toBeNull();
  return [...block![1].matchAll(/'((?:lib|components|app)\/[^']+\.tsx?)'/g)].map((m) => m[1]);
}

/** The ids the fixture hands back itself, from its `const mocks = { ... }`. */
function mockedIds(spec: string): Set<string> {
  const block = /const mocks = \{([\s\S]*?)\n    \};/.exec(readFileSync(spec, 'utf8'));
  expect(block, `${spec} no longer has a mock map this guard can read`).not.toBeNull();
  return new Set([...block![1].matchAll(/'(@\/[^']+)'\s*:/g)].map((m) => m[1]));
}

describe.each(SPECS)('%s provides every module its fixture will load', (spec) => {
  it('lists each value import reachable from the files it names', () => {
    const listed = listedSources(spec);
    const mocked = mockedIds(spec);
    // A guard that stops matching passes forever; these fixtures name ~20 files.
    expect(listed.length, 'the source list was not parsed').toBeGreaterThan(10);
    expect(mocked.size, 'the mock map was not parsed').toBeGreaterThan(3);

    const provided = new Set(listed);
    const seen = new Set(listed);
    const queue = [...listed];
    const missing: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      // Value imports only: `import type ... from` is erased by transpilation and
      // never reaches the loader, so demanding it would ask for absent modules.
      for (const match of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\s)[^;]*?from '([^']+)'/gm)) {
        const next = resolveAlias(match[1], file);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        // A mocked id replaces the real module wholesale, so the fixture needs
        // neither its source nor anything it would have imported.
        if (mocked.has(`@/${next.replace(/\.tsx?$/, '')}`)) continue;
        if (!provided.has(next)) { missing.push(`${next}  (imported by ${file})`); continue; }
        queue.push(next);
      }
    }
    expect(missing, `add these to the source list in ${spec} or the fixture cannot mount`).toEqual([]);
  });
});
