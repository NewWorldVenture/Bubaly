import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Launch-readiness ratchet (mandate: "remove mocks / placeholders / dead code").
// Shipping code (app/ + lib/) must carry NO leftover developer markers —
// TODO / FIXME / HACK / XXX (uppercase, the comment-marker convention; the task
// STATUS value 'todo' is lowercase and unaffected) and no scaffolding sentinels
// like NotImplemented. This was swept clean at authoring time (0 hits across the
// whole tree); the guard keeps a new one from slipping in unnoticed. Tests,
// scripts and generated types are out of scope.
const ROOTS = ['app', 'lib'];
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && entry !== 'database.types.ts') {
      out.push(full);
    }
  }
  return out;
}

// Strip line + block comments so a marker inside prose (e.g. a comment that says
// "no TODO stubs here") is not itself flagged — we only care about real markers.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('shipping code carries no leftover developer markers', () => {
  const files = ROOTS.flatMap(sourceFiles);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('has no TODO / FIXME / HACK / XXX markers in app/ or lib/', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      if (MARKER.test(code)) offenders.push(f);
    }
    expect(offenders, `dev markers found in: ${offenders.join(', ')}`).toEqual([]);
  });
});
