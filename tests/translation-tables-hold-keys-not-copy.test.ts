import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S4-03.
 *
 * `COMPLETE_REASON` mapped refusal reasons to a mix of catalogue keys and
 * literal English, and every value was passed through `t()`. `translate()`
 * falls back to the key when it resolves nothing, so an English sentence used
 * as a key renders as itself: correct-looking in en-US, untranslated in the
 * other ten locales. A key that renders as readable English is much harder to
 * notice than one that renders as `siteFooter.acceptableUse`.
 *
 * This generalises past that one file. Any lookup table whose values reach
 * `t()` — `t(TABLE[x])` or `t(TABLE.x)` — must hold keys the catalogue
 * actually resolves.
 */
const catalogue = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
};
['app', 'lib', 'components'].forEach(walk);

/** `const NAME: Record<string, string> = { a: 'x', … }` — the table shape. */
function tableValues(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}: Record<string, string> = {`);
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf('};', start));
  return [...body.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('a table read through t() holds catalogue keys', () => {
  it('every such value resolves in en-US', () => {
    const offenders: string[] = [];
    let tablesChecked = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const consumed = new Set(
        [...source.matchAll(/\bt\(\s*([A-Z][A-Z0-9_]*)\s*[[.]/g)].map((m) => m[1]),
      );
      for (const name of consumed) {
        const values = tableValues(source, name);
        if (!values.length) continue;
        tablesChecked++;
        for (const value of values) {
          if (!(value in catalogue)) offenders.push(`${file} — ${name}: ${JSON.stringify(value)}`);
        }
      }
    }
    // A matcher that silently matches nothing is this repository's signature
    // defect, so the census asserts it found the tables it is named for.
    expect(tablesChecked, 'no t()-consumed tables found — the matcher stopped working').toBeGreaterThan(0);
    expect(offenders, 'these render as raw English in every non-English locale').toEqual([]);
  });

  it('covers the table the finding was filed against', () => {
    const source = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
    const values = tableValues(source, 'COMPLETE_REASON');
    expect(values).toHaveLength(8);
    for (const value of values) expect(catalogue, value).toHaveProperty(value);
  });
});
