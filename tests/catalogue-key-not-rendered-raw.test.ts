import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The live footer showed every visitor the text "siteFooter.acceptableUse".
//
// A bulk i18n pass had replaced the literal 'Acceptable Use' with the catalogue
// KEY inside a `label:` field of a plain data array — and that array is rendered
// as `{l.label}`, not `{t(l.label)}`. So the key printed verbatim on every
// marketing page.
//
// Nothing caught it. The i18n scanner looks for hardcoded ENGLISH in JSX, and a
// key is not English; the catalogue gate looks for missing keys, and the key
// existed. Typecheck is happy because both are strings. The failure lives in the
// gap between "is it translated" and "is it a key pretending to be copy".
//
// This closes that gap with the signal that actually separates the two cases:
// consistency among siblings. A list whose `title` is a key in EVERY entry is
// fine — the render site wraps it in t() (FEATURE_RAIL on the homepage does
// exactly this). A list where one `label` is 'tripActivities.booked' and its
// neighbours are 'Duration (min)', 'Link' and 'Notes' is the bug: the render
// site prints those neighbours verbatim, so it prints the key verbatim too.
//
// So: flag a key-shaped value only where the same field, IN THE SAME ARRAY, also
// holds real copy. One of these is not like the others.
//
// Scoping to the declaration matters, not just the file: visual-mocks.tsx uses
// `title` for both FEATURE_RAIL (all keys, rendered through t() by the homepage)
// and a mock schedule (all plain copy, rendered raw). Judged per file those two
// look mixed and the check cries wolf; judged per declaration each is internally
// consistent and neither is reported.
const FIELDS = ['label', 'title', 'heading', 'text', 'name', 'placeholder'];

// `word.word` or deeper, no spaces — the shape of a catalogue key and of almost
// nothing a human is meant to read.
const KEY_SHAPED = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report', 'ios', 'android', 'mobile',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe('a catalogue key is never rendered as copy', () => {
  it('no display field holds something shaped like a catalogue key', () => {
    const pattern = new RegExp(`\\b(${FIELDS.join('|')})\\s*:\\s*'([^']+)'`, 'g');
    const offenders: string[] = [];

    for (const file of [...walk('app'), ...walk('components')]) {
      const src = readFileSync(file, 'utf8');

      // Scope = the declaration a match sits under. Entries of one array share
      // a declaration; two arrays in the same file do not. (Bracket-depth
      // counting is the obvious alternative and is not robust here — a stray
      // bracket in a comment or a regex silently collapses every scope into
      // one, which is how this check first cried wolf on FEATURE_RAIL.)
      const lines = src.split('\n');
      const declOfLine: string[] = [];
      let currentDecl = '<file>';
      for (const [i, line] of lines.entries()) {
        const decl = line.match(/^\s*(?:export\s+)?(?:const|let|var|function)\s+(\w+)/);
        if (decl) currentDecl = `${decl[1]}@${i}`;
        declOfLine.push(currentDecl);
      }
      const lineOfOffset = (offset: number) => src.slice(0, offset).split('\n').length - 1;

      // (declaration, field) → its key-shaped values, and whether plain copy
      // shares that same field under that same declaration.
      const keyed = new Map<string, { field: string; values: string[] }>();
      const hasPlainCopy = new Set<string>();

      for (const m of src.matchAll(pattern)) {
        const [, field, value] = m;
        // A filename or a dotted domain is not a catalogue key.
        if (/\.(tsx?|jsx?|mjs|json|css|png|jpe?g|svg|webp|ico|com|org|net|io|app|dev)$/.test(value)) continue;
        const scope = `${declOfLine[lineOfOffset(m.index ?? 0)]}::${field}`;
        if (KEY_SHAPED.test(value)) {
          const bucket = keyed.get(scope) ?? { field, values: [] };
          bucket.values.push(value);
          keyed.set(scope, bucket);
        } else if (/[A-Za-z]/.test(value)) {
          hasPlainCopy.add(scope);
        }
      }

      for (const [scope, { field, values }] of keyed) {
        if (!hasPlainCopy.has(scope)) continue; // internally consistent: fine
        for (const value of values) offenders.push(`${file}: ${field}: '${value}'`);
      }
    }

    expect(
      offenders,
      `These look like catalogue keys sitting in a field that renders as text.\n` +
        `Rename the field to ${'`'}labelKey${'`'}/${'`'}titleKey${'`'} and render it through t(), ` +
        `or put the real copy here:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
