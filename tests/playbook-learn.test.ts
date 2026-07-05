import { describe, it, expect } from 'vitest';
import { learnPlaybook, filterAlreadyKnown, type PlaybookSignals } from '@/lib/playbook/learn';

const empty: PlaybookSignals = { dinners: [], groceryDays: [], routines: [] };

describe('learnPlaybook', () => {
  it('returns nothing for a family with no signal', () => {
    expect(learnPlaybook(empty)).toEqual([]);
  });

  it('learns a favorite dinner cooked >= 3 times', () => {
    const out = learnPlaybook({ ...empty, dinners: ['Tacos', 'tacos', 'TACOS', 'Pasta'] });
    const meal = out.find((i) => i.key === 'meal:tacos');
    expect(meal).toBeTruthy();
    expect(meal!.value).toBe('Tacos');           // display casing preserved
    expect(meal!.detail).toMatch(/3×/);
    expect(out.some((i) => i.key === 'meal:pasta')).toBe(false); // only once → below threshold
  });

  it('learns the usual shopping day when one weekday dominates', () => {
    const out = learnPlaybook({ ...empty, groceryDays: [0, 0, 0, 0, 3] }); // mostly Sunday
    const day = out.find((i) => i.label === 'Usual shopping day');
    expect(day?.value).toBe('Sunday');
    expect(day?.detail).toMatch(/4 of the last 5/);
  });

  it('does not claim a shopping day without a clear pattern', () => {
    const out = learnPlaybook({ ...empty, groceryDays: [0, 1, 2, 3, 4, 5] }); // spread out
    expect(out.some((i) => i.label === 'Usual shopping day')).toBe(false);
  });

  it('needs enough grocery samples before guessing a day', () => {
    const out = learnPlaybook({ ...empty, groceryDays: [0, 0] }); // < 4
    expect(out.some((i) => i.label === 'Usual shopping day')).toBe(false);
  });

  it('learns recurring routines with a weekday label', () => {
    const out = learnPlaybook({ ...empty, routines: [{ title: 'Swim practice', daysOfWeek: [2, 4] }] });
    const r = out.find((i) => i.key === 'routine:swim practice');
    expect(r?.value).toBe('Swim practice');
    expect(r?.detail).toBe('Tue, Thu');
  });

  it('ranks most-confident first and caps at the limit', () => {
    const out = learnPlaybook(
      { dinners: ['Tacos', 'Tacos', 'Tacos', 'Tacos'], groceryDays: [1, 1, 1, 1], routines: [{ title: 'X', daysOfWeek: [1] }] },
      { limit: 2 },
    );
    expect(out).toHaveLength(2);
    expect(out[0].confidence).toBeGreaterThanOrEqual(out[1].confidence);
  });

  it('is deterministic', () => {
    const s: PlaybookSignals = { dinners: ['A', 'A', 'A'], groceryDays: [6, 6, 6, 6], routines: [] };
    expect(learnPlaybook(s)).toEqual(learnPlaybook(s));
  });
});

describe('filterAlreadyKnown', () => {
  it('drops insights already saved as facts (case-insensitive)', () => {
    const insights = learnPlaybook({ ...empty, dinners: ['Tacos', 'Tacos', 'Tacos'] });
    const filtered = filterAlreadyKnown(insights, [{ label: 'Favorite dinner', value: 'tacos' }]);
    expect(filtered.some((i) => i.key === 'meal:tacos')).toBe(false);
  });

  it('keeps insights that are not yet saved', () => {
    const insights = learnPlaybook({ ...empty, dinners: ['Pizza', 'Pizza', 'Pizza'] });
    const filtered = filterAlreadyKnown(insights, [{ label: 'Favorite dinner', value: 'Tacos' }]);
    expect(filtered.some((i) => i.key === 'meal:pizza')).toBe(true);
  });
});
