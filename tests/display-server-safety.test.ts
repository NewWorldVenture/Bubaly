import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Regression guard for the Kitchen Display's production crash loop.
//
// display-grid.tsx is a 'use client' module. When the SERVER page imported
// helpers from it (resolveTiles / resolveDisplaySettings / DEFAULT_TILES —
// even as re-exports of pure libs), each arrived as a client-reference proxy:
// CALLING one throws on every request, and because the page's catch block
// called another poisoned helper, the second throw escaped every guard and
// crashed the kiosk into the error boundary as an opaque digest — on every
// build, invisible to tsc/eslint/vitest/next-build (none render RSC).
//
// Rule enforced here: a SERVER file in the display segment may import from a
// 'use client' module ONLY (a) type-only imports (erased at compile) or
// (b) PascalCase component names (legal to render as JSX). Pure helpers must
// come from lib/display/* directly.

const ROOT = process.cwd();
const DISPLAY_DIR = join(ROOT, 'app', '(app)', 'display');

function sourceIsClientModule(specifier: string): boolean {
  if (!specifier.startsWith('@/')) return false;
  const base = join(ROOT, specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) {
      const head = readFileSync(candidate, 'utf8').slice(0, 200);
      return /^\s*['"]use client['"]/.test(head);
    }
  }
  return false;
}

type Violation = { file: string; specifier: string; name: string };

function violationsIn(filePath: string): Violation[] {
  const src = readFileSync(filePath, 'utf8');
  // Server files only — a 'use client' file may import anything from clients.
  if (/^\s*['"]use client['"]/.test(src.slice(0, 200))) return [];

  const out: Violation[] = [];
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const [, typeOnly, names, specifier] = m;
    if (typeOnly) continue;                       // `import type {...}` — erased
    if (!sourceIsClientModule(specifier)) continue;
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (!name || name.startsWith('type ')) continue;   // inline type import — erased
      const bare = name.split(/\s+as\s+/)[0].trim();
      if (!/^[A-Z][A-Za-z0-9]*$/.test(bare) || bare === bare.toUpperCase()) {
        // Not a PascalCase component (helpers are camelCase; constants are
        // SCREAMING_CASE) → a client-reference proxy that throws when used.
        out.push({ file: filePath.slice(ROOT.length + 1), specifier, name: bare });
      }
    }
  }
  return out;
}

describe('Kitchen Display server/client import boundary', () => {
  it('server files in the display segment import no callable values from client modules', () => {
    const files = readdirSync(DISPLAY_DIR)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map((f) => join(DISPLAY_DIR, f));
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(violationsIn);
    expect(
      violations,
      `Server code imported non-component values from a 'use client' module — these are client-reference proxies that THROW when called during the server render (the exact bug behind the kiosk's "One moment…" crash loop). Import them from the pure lib instead:\n${violations.map((v) => `  ${v.file}: { ${v.name} } from '${v.specifier}'`).join('\n')}`,
    ).toEqual([]);
  });

  it('detector recognizes the original bad import as a violation (self-test)', () => {
    // display-grid.tsx must still be a client module for this guard to matter.
    expect(sourceIsClientModule('@/components/display/display-grid')).toBe(true);
    // And the pure libs must NOT be client modules (server code relies on them).
    expect(sourceIsClientModule('@/lib/display/tiles')).toBe(false);
    expect(sourceIsClientModule('@/lib/display/ambient')).toBe(false);
  });
});
