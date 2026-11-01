import { describe, expect, it } from 'vitest';
import { reconcile } from '../scripts/audit-register-counts.mjs';

// In-memory documents only: no actual ledger, filesystem writes or child CLI.
const live = '- Overall audit completion under the adopted formula: **40.00%** ((2 verified closures + **0** independently credited external blocks) / 5). Historical evidence does not grant external credit.';
const rows = [
  '| TEST-OPEN | source | Low | ⬜ NOT STARTED |',
  '| TEST-ACTIVE | source | High | 🔄 IN PROGRESS |',
  '| TEST-PASS | source | High | ✅ PASS |',
  '| TEST-FIXED | source | High | 🛠 FIXED + PASS |',
  '| TEST-BLOCKED | source | High | ⚠️ BLOCKED |',
];
const summary = [
  '## Current reconciled audit counts',
  '- Total Audit Items: **5**',
  '- Not Started: **1**',
  '- In Progress: **1**',
  '- Passed: **1**',
  '- Fixed + Passed: **1**',
  '- Blocked: **1**',
  '- Verified closure coverage: **40.00%** (2 / 5)',
];
const document = (formula = live, extra: string[] = []) => [
  '# Register B — synthetic inventory (5 items)', ...rows,
  '# Summary', ...summary, ...extra, formula, '',
].join('\n');
const refuses = (markdown: string) => expect(reconcile(markdown).problems).not.toEqual([]);

describe('the live adopted audit completion formula', () => {
  it('accepts a healthy mixed-status register and its independently stated formula', () => {
    const result = reconcile(document());
    expect(result.problems).toEqual([]);
    expect(result.register.closed).toBe(2);
    expect(result.register.total).toBe(5);
  });
  it('accepts comma-formatted operands against one thousand unique literal-status rows', () => {
    const thousand = Array.from({ length: 1000 }, (_, index) => `| COUNT-${index} | source | Low | ✅ PASS |`);
    const markdown = [
      '# Register B — synthetic inventory (1,000 items)', ...thousand, '# Summary',
      '## Current reconciled audit counts', '- Total Audit Items: **1,000**',
      '- Not Started: **0**', '- In Progress: **0**', '- Passed: **1,000**',
      '- Fixed + Passed: **0**', '- Blocked: **0**',
      '- Verified closure coverage: **100.00%** (1,000 / 1,000)',
      '- Overall audit completion under the adopted formula: **100.00%** ((1,000 verified closures + **0** independently credited external blocks) / 1,000). Commas are presentation.',
    ].join('\n');
    expect(reconcile(markdown).problems).toEqual([]);
  });
  it('refuses a stale verified-closure operand', () => {
    refuses(document(live.replace('2 verified closures', '1 verified closures')));
  });
  it('refuses a stale denominator', () => {
    refuses(document(live.replace('/ 5)', '/ 6)')));
  });
  it('refuses a stale percentage while counts remain correct', () => {
    refuses(document(live.replace('40.00%', '39.99%')));
  });
  it('refuses self-consistent arithmetic that grants unreviewed external credit', () => {
    refuses(document(live.replace('40.00%', '60.00%').replace('**0** independently', '**1** independently')));
  });
  it('keeps blocked rows visible without adding closure credit', () => {
    const result = reconcile(document());
    expect(result.problems).toEqual([]);
    expect(result.register.counts.blocked).toBe(1);
    expect(result.register.closed).toBe(2);
  });
  it('refuses a missing live record', () => {
    refuses(document(''));
  });
  it('refuses a malformed live formula even when the reconciled summary is healthy', () => {
    refuses(document('- Overall audit completion under the adopted formula: **40.00%** (2 + 0 / 5).'));
  });
  it('refuses two identical live records', () => {
    refuses(document(live, [live]));
  });
  it('refuses conflicting duplicate live records', () => {
    refuses(document(live, [live.replace('40.00%', '60.00%')]));
  });
  it('ignores an old blockquoted live-looking record', () => {
    expect(reconcile(document(live, ['> ' + live.replace('40.00%', '1.00%')])).problems).toEqual([]);
  });
  it('ignores fenced live-looking records with either Markdown fence delimiter', () => {
    expect(reconcile(document(live, ['```md', live.replace('40.00%', '1.00%'), '```', '~~~', live, '~~~'])).problems).toEqual([]);
  });
  it('preserves dated historical prose without treating it as a live record', () => {
    expect(reconcile(document(live, ['2026-01-01 historical completion was 1.00% (1 / 100); retained as evidence.'])).problems).toEqual([]);
  });
  it('accepts healthy CRLF documents', () => {
    expect(reconcile(document().replace(/\n/g, '\r\n')).problems).toEqual([]);
  });
  it('refuses an unsafe oversized formula operand', () => {
    refuses(document(live.replace('2 verified closures', '9007199254740992 verified closures')));
  });
  it('refuses an empty register rather than accepting nonfinite completion arithmetic', () => {
    const markdown = [
      '# Register B — synthetic inventory (0 items)', '# Summary',
      '## Current reconciled audit counts', '- Total Audit Items: **0**',
      '- Not Started: **0**', '- In Progress: **0**', '- Passed: **0**',
      '- Fixed + Passed: **0**', '- Blocked: **0**',
      '- Verified closure coverage: **0.00%** (0 / 0)',
      '- Overall audit completion under the adopted formula: **0.00%** ((0 verified closures + **0** independently credited external blocks) / 0).',
    ].join('\n');
    refuses(markdown);
  });
});