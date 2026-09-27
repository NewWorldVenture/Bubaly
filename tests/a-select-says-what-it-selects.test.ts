import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A `<select>` with no accessible name is announced as "combo box" and nothing
// else. The user is told there is a choice and not what it is about — and these
// are filters, so the page's contents change under them (F-D03).
//
// ── why this is a test and not a lint rule ─────────────────────────────────
//
// `.eslintrc.json` now enables `jsx-a11y/label-has-associated-control`, which
// `next/core-web-vitals` does not carry — that omission is how 55 labels came
// to be detached from their control (F-D02, F-D10). It is set to depth 4
// rather than the default 2, because the house pattern wraps the control and
// puts its text in a nested element beside it:
//
//   <label><input type="checkbox" /><div><p>Emergency contact</p><p>…</p></div></label>
//
// which is correctly labelled and three levels down. At depth 2 the rule
// reported exactly three of those and nothing else, so raising it removes false
// positives rather than findings.
//
// "At depth 4 the tree is clean" used to close this paragraph, and it was not
// evidence: the rule treats any `{expression}` child as a possible nested
// control, so it never reports `<label>{t('…')}</label>`, which is how nearly
// every label here is written. 50 detached labels were found by parsing the JSX
// instead (A11Y-002's correction); tests/a-control-has-a-name.test.ts holds
// them, and the icon buttons and selects, at zero.
//
// `jsx-a11y/control-has-associated-label` is deliberately NOT enabled. It
// reports 561 violations here, and the first one sampled is
//
//   <label className="block"><span>OpenAI API key</span><input type="password" /></label>
//
// which is correct markup. A rule whose findings are mostly wrong is a rule
// everyone learns to skip past, and skipping past it is how a real one hides.
// So the genuinely unnamed controls it was reaching for are counted here
// instead, by a check that cannot be satisfied by nesting depth.
//
// ── a gate, now ────────────────────────────────────────────────────────────
//
// This was a ratchet at 71 of 144. Every select is now named, through a shared
// `fieldName.*` namespace in all seven catalogues and a required `label` on
// FilterSelect (MAIN-F-D03), so the ceiling is zero. The stricter AST check in
// tests/a-control-has-a-name.test.ts, where an id counts only if a label points
// at it, holds the same line.
const CEILING = 0;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * `<select>` elements in one file with no accessible name.
 *
 * Named counts as: `aria-label`, `aria-labelledby`, an `id` (the house `Field`
 * pattern hands one down and renders a `<label htmlFor>`), or a wrapping
 * `<label>` opened above it at a shallower indent.
 */
export function unnamedSelects(source: string): number[] {
  const lines = blankComments(source).split('\n');
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (!/<select\b/.test(line)) return;
    let el = '';
    // The tag ends at a `>` that is not the arrow of `(e) => …`: stopping at the
    // arrow is how this used to miss an aria-label three lines further down, and
    // count a named select as unnamed.
    for (let k = i; k < Math.min(lines.length, i + 10); k++) { el += `${lines[k]} `; if (/(^|[^=])>/.test(lines[k])) break; }
    // `{...props}`: the ui Select primitive passes its caller's name through.
    if (/aria-label|aria-labelledby|\bid=|\{\.\.\.\w+\}/.test(el)) return;
    const indent = line.length - line.trimStart().length;
    for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
      const prev = lines[k];
      if (/<\/label>/.test(prev)) break;
      if (/<label\b/.test(prev) && prev.length - prev.trimStart().length < indent) return;
    }
    out.push(i + 1);
  });
  return out;
}

describe('a select says what it selects', () => {
  const files = [...walk('components'), ...walk('app')];
  const sources = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
  const total = sources.reduce(
    (n, [, s]) => n + blankComments(s).split('\n').filter((l) => /<select\b/.test(l)).length, 0);
  const unnamed = sources.flatMap(([f, s]) => unnamedSelects(s).map((n) => `${f}:${n}`));

  it('finds the selects (non-vacuity)', () => {
    // A scan that stopped matching would satisfy the ceiling forever.
    expect(total).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(200);
  });

  it('reads naming the four ways it is done here (sanity)', () => {
    expect(unnamedSelects('<select value={x} onChange={f}>')).toEqual([1]);
    expect(unnamedSelects('<select aria-label="Filter by member" value={x}>')).toEqual([]);
    expect(unnamedSelects('<select aria-labelledby="who" value={x}>')).toEqual([]);
    expect(unnamedSelects('<select id={id} value={x}>')).toEqual([]);
    expect(unnamedSelects('<label>\n  <span>Role</span>\n  <select value={x}>\n</label>')).toEqual([]);
    // A label that CLOSED above is not this select's label.
    expect(unnamedSelects('<label>\n  <span>Role</span>\n</label>\n<select value={x}>')).toEqual([4]);
    // Prose about aria-label is not an aria-label.
    expect(unnamedSelects('{/* needs aria-label */}\n<select value={x}>')).toEqual([2]);
    // An arrow in an earlier attribute does not end the tag.
    expect(unnamedSelects('<select\n  onChange={(e) => f(e)}\n  aria-label={t(\'k\')}\n>')).toEqual([]);
    expect(unnamedSelects('<select ref={ref} className={c} {...props} />')).toEqual([]);
  });

  it(`has no more than ${CEILING} unnamed selects`, () => {
    expect(
      unnamed.length,
      `Unnamed <select> count went UP (${unnamed.length} > ${CEILING}).\n`
      + 'Give it an aria-label, or an id the visible label points at. Do not raise CEILING.\n'
      + unnamed.slice(0, 20).join('\n'),
    ).toBeLessThanOrEqual(CEILING);
  });

  it('keeps the lint rule that holds the other half', () => {
    // F-D02's repair is only durable while the rule that catches it is on, and
    // at the depth this codebase's markup actually uses.
    const config = JSON.parse(readFileSync('.eslintrc.json', 'utf8')) as {
      rules?: Record<string, unknown>;
    };
    const rule = config.rules?.['jsx-a11y/label-has-associated-control'];
    expect(rule, 'label-has-associated-control must stay enabled').toBeDefined();
    expect(JSON.stringify(rule)).toContain('"depth":4');
    expect(JSON.stringify(rule)).toContain('error');
  });
});
