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
// positives rather than findings. At depth 4 the tree is clean.
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
// ── a ratchet, not a gate ──────────────────────────────────────────────────
//
// 71 of 144. Naming them is 71 pieces of product copy in seven languages, which
// is a writing task for whoever owns the product voice rather than something to
// invent in an audit. What this does is stop the number growing, and make each
// reduction deliberate. Lower CEILING as they are named; never raise it.
const CEILING = 71;

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
    for (let k = i; k < Math.min(lines.length, i + 10); k++) { el += `${lines[k]} `; if (/>/.test(lines[k])) break; }
    if (/aria-label|aria-labelledby|\bid=/.test(el)) return;
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
