import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mobile production-readiness (Phase 7 — M-006): a `type="number"` money/decimal
// field (step="0.01" / "0.1" / "any", or a 0.00 placeholder) needs
// `inputMode="decimal"` so iOS Safari shows a keypad WITH a decimal point —
// `type="number"` alone doesn't reliably surface the "." on iOS, blocking cents
// entry. This guard forbids a decimal money input from regressing to no inputMode.
//
// It used to read `components/modules` only, and with `readdirSync` rather than
// a walk — so one flat directory of the tree. Everything in it complied, the
// sanity check below passed on that directory alone, and the guard looked
// healthy while TWENTY-SIX money inputs outside it had no inputMode at all:
// every wallet balance and limit, bill and budget amounts, savings targets,
// trip budgets and itinerary costs, nutrition grams. That is the money-entry
// surface of the app, and on iOS none of it could take a decimal point.
//
// So it walks `app` and `components` now. A guard that inspects one directory
// of a tree reports on that directory, not on the rule.
const ROOTS = ['app', 'components'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

/** A single-line JSX input that is a number field with a decimal step / 0.00 placeholder. */
function isDecimalNumberInput(line: string): boolean {
  return /type="number"/.test(line) && /(step="(0\.01|0\.1|any)"|placeholder="0\.00")/.test(line);
}

function decimalNumberInputLines(src: string): string[] {
  return src.split('\n').filter(isDecimalNumberInput);
}

describe('decimal / money number inputs request the decimal keypad on mobile (M-006)', () => {
  it('every type=number decimal-step input carries inputMode="decimal"', () => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (isDecimalNumberInput(line) && !/inputMode/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, `decimal number inputs missing inputMode="decimal": ${offenders.join(', ')}`).toEqual([]);
  });

  it('actually covers a meaningful number of money inputs (sanity)', () => {
    const total = files.reduce((n, f) => n + decimalNumberInputLines(fs.readFileSync(f, 'utf8')).length, 0);
    // The old bound was 20, which one flat directory met on its own — which is
    // how the scan could miss 26 offenders and still look like it was working.
    expect(total).toBeGreaterThan(60);
  });

  it('scans past the one directory it used to read', () => {
    // Non-vacuity of the WALK, not of the rule: the old readdirSync saw only
    // `components/modules/*.tsx`. If a refactor flattens this back, the counts
    // below go to zero and this fails rather than quietly narrowing again.
    expect(files.filter((f) => f.startsWith(`components${path.sep}wallet`)).length).toBeGreaterThan(0);
    expect(files.filter((f) => f.startsWith(`app${path.sep}`)).length).toBeGreaterThan(0);
    // Nested deeper than one level — the old scan could not reach these at all.
    expect(files.filter((f) => f.split(path.sep).length > 3).length).toBeGreaterThan(0);
  });

  it('recognises the pattern it forbids', () => {
    expect(isDecimalNumberInput('<Input type="number" step="0.01" value={v} />')).toBe(true);
    expect(isDecimalNumberInput('<input type="number" placeholder="0.00" />')).toBe(true);
    // A whole-number field is not a decimal field and is not this rule's business.
    expect(isDecimalNumberInput('<Input type="number" step="1" value={qty} />')).toBe(false);
    expect(isDecimalNumberInput('<Input type="text" step="0.01" />')).toBe(false);
  });
});
