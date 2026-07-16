import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-10 — the Meals module's secondary/enhancement client reads (the "add from
// your meals" library and the weekly dinner-vote panel) must not swallow a read
// failure into a silent empty list. The primary meal_plans read already fails
// visibly via useRealtimeQuery → <ErrorState>; these guards keep the two
// secondary reads from regressing back to a silent `data ?? []`.
const src = readFileSync('components/modules/meals-module.tsx', 'utf8');

describe('meals-module secondary reads log on failure', () => {
  it('the meal-library read checks + logs its error', () => {
    expect(src).toContain("console.error('[meals] library read failed'");
  });

  it('the weekly vote read checks + logs its error', () => {
    expect(src).toContain("console.error('[meals] vote read failed'");
    expect(src).toContain("console.error('[meals] vote detail read failed'");
  });

  it('no longer destructures only `data` from the library read (the silent pattern)', () => {
    expect(src).not.toContain('.then(({ data }) => setLibrary(data ?? []))');
  });
});
