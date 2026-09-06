import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The one page that lists a family's routines described them as
// "When schedule → ai_request" — two column values, no next-run time, and no
// sign of the sentence the family actually typed. The same page's form offered
// eight triggers ("Task overdue", "Bill due", "Stress score high") that no code
// anywhere evaluates, so every rule it created was inert the moment it was
// saved. A page that sells automation nothing performs is worse than no page.
const page = readFileSync('app/(app)/dashboard/family-automation/page.tsx', 'utf8');
const src = page.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('the family automation page', () => {
  it('tells routines apart from the legacy rules', () => {
    expect(src).toContain('const routines = allRules.filter((r) => r.schedule_kind)');
    expect(src).toContain('const rules = allRules.filter((r) => !r.schedule_kind)');
  });

  it('shows a routine the way the family said it, and when it next runs', () => {
    const section = src.slice(src.indexOf('Bubaly routines'), src.indexOf('Automation Rules'));
    expect(section).toContain('{r.said || r.name}');
    expect(section).toContain('Next: ${fmtRelative(r.next_run_at)}');
    // An unarmed relative routine says why rather than showing nothing.
    expect(section).toContain('Waiting for something to count back from');
    expect(section).toContain("'Paused'");
  });

  it('no longer offers triggers nothing evaluates', () => {
    // The list is still declared for reading old rows; what is gone is the form
    // that let a family create more of them.
    expect(src).not.toContain("options: TRIGGERS");
    expect(src).not.toContain('QuickAdd');
  });

  it('describes the legacy rules honestly instead of as automation', () => {
    expect(src).toContain('Their triggers are not evaluated by anything');
  });
});
