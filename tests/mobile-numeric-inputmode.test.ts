import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mobile production-readiness (Phase 7 — M-006): a `type="number"` money/decimal
// field (step="0.01" / "0.1" / "any", or a 0.00 placeholder) needs
// `inputMode="decimal"` so iOS Safari shows a keypad WITH a decimal point —
// `type="number"` alone doesn't reliably surface the "." on iOS, blocking cents
// entry. This guard forbids a decimal money input from regressing to no inputMode.

const MODULES_DIR = 'components/modules';
const files = fs
  .readdirSync(MODULES_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => path.join(MODULES_DIR, f));

// Split a source into single-line JSX-ish input segments and keep the ones that are
// a number input with a decimal step / 0.00 placeholder.
function decimalNumberInputLines(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => /type="number"/.test(l) && /(step="(0\.01|0\.1|any)"|placeholder="0\.00")/.test(l));
}

describe('decimal / money number inputs request the decimal keypad on mobile (M-006)', () => {
  it('every type=number decimal-step input carries inputMode="decimal"', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/type="number"/.test(line) && /(step="(0\.01|0\.1|any)"|placeholder="0\.00")/.test(line) && !/inputMode/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders, `decimal number inputs missing inputMode="decimal": ${offenders.join(', ')}`).toEqual([]);
  });

  it('actually covers a meaningful number of money inputs (sanity)', () => {
    const total = files.reduce((n, f) => n + decimalNumberInputLines(fs.readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(20);
  });
});
