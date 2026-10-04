import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FILE,
  countRegister,
  readRegister,
  reconcile,
} from '../scripts/audit-register-counts.mjs';

// The "Current reconciled audit counts" section of finalaudit.md was a
// hand-kept tally that every checkpoint carried forward with "no recount was
// performed" — and two checkpoints disagreed by one row in two columns. The
// register rows are the evidence; the summary is derived from them, so a
// summary that drifts from its rows fails here instead of being copied on.
describe('the audit summary counts its own register', () => {
  const markdown = readFileSync(AUDIT_FILE, 'utf8');
  // The first NOT STARTED row inside Register B (the file has other tables).
  const firstOpenRow = () =>
    readRegister(markdown).rows.find((row: { status: string }) => row.status === '⬜ NOT STARTED')!.line - 1;

  it('states exactly what Register B holds, row by row', () => {
    const { problems, register } = reconcile(markdown);
    expect(problems).toEqual([]);
    expect(register.total).toBeGreaterThan(14_000);
  });

  it('notices a summary that has drifted from the rows', () => {
    const drifted = markdown.replace(
      /^(- Not Started: \*\*)([\d,]+)(\*\*)/m,
      (_, open: string, value: string, close: string) =>
        `${open}${(Number(value.replace(/,/g, '')) + 1).toLocaleString('en-US')}${close}`,
    );
    expect(drifted).not.toBe(markdown);
    expect(reconcile(drifted).problems.join('\n')).toMatch(/"Not Started" says/);
  });

  it('notices a register row whose status is not one of the five', () => {
    const lines = markdown.split('\n');
    const index = firstOpenRow();
    lines[index] = lines[index].replace('| ⬜ NOT STARTED |', '| DONE |');
    const { unknown } = countRegister(lines.join('\n'));
    expect(unknown).toHaveLength(1);
  });

  it('notices an ID registered twice', () => {
    const lines = markdown.split('\n');
    const index = firstOpenRow();
    lines.splice(index + 1, 0, lines[index]);
    expect(countRegister(lines.join('\n')).duplicates).toHaveLength(1);
  });
});
