import { describe, it, expect } from 'vitest';
import {
  assessAffordability,
  buildCashflowTimeline,
  type BuildTimelineInput,
  type TimelineBill,
} from '@/lib/finance/timeline';

// "Can we afford it?" — a commitment tried against the WHOLE forward forecast
// (every bill, set-aside and plan-linked commitment), not one budget category.
// Deterministic: NOW is a Monday, rent lands the week of Jan 5, Feb 9, Mar 9.
const NOW = new Date('2026-01-05T00:00:00Z');

function bill(p: Partial<TimelineBill>): TimelineBill {
  return { name: 'Bill', amount: 100, due_date: '2026-01-10', is_recurring: false, recurrence: null, status: 'unpaid', category: null, ...p };
}

// Balances as-is: 4000 → 3000 (Jan 10) → 2000 (Feb 10) → 1000 (Mar 10).
function base(over: Partial<BuildTimelineInput> = {}): BuildTimelineInput {
  return {
    bills: [bill({ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly' })],
    goals: [], events: [], startingBalance: 4000, buffer: 200, now: NOW, ...over,
  };
}

describe('assessAffordability', () => {
  it('says ok when the commitment leaves comfortable headroom above the buffer', () => {
    const r = assessAffordability(base(), { label: 'Car seat', amount: 300, date: '2026-01-20' });
    expect(r.verdict).toBe('ok');
    expect(r.before).toEqual({ lowestBalance: 1000, lowestBalanceWeek: '2026-03-09' });
    expect(r.after).toEqual({ lowestBalance: 700, lowestBalanceWeek: '2026-03-09' });
    expect(r.headroom).toBe(500);
    expect(r.scenario).toEqual({ label: 'Car seat', date: '2026-01-20', total: 300, occurrences: 1, recurring: false });
    // From the week it lands, the base balance never drops below 1000 → 800 keeps the buffer.
    expect(r.maxAffordable).toBe(800);
  });

  it('says tight when it fits but the headroom shrinks under one buffer', () => {
    const r = assessAffordability(base(), { label: 'Bike', amount: 700, date: '2026-01-20' });
    expect(r.verdict).toBe('tight');
    expect(r.after.lowestBalance).toBe(300);
    expect(r.headroom).toBe(100);
    expect(r.maxAffordable).toBe(800);
  });

  it('flips the verdict to breaches when the same commitment crosses the buffer', () => {
    const ok = assessAffordability(base(), { label: 'Bike', amount: 300, date: '2026-01-20' });
    const breaches = assessAffordability(base(), { label: 'Bike', amount: 900, date: '2026-01-20' });
    expect(ok.verdict).toBe('ok');
    expect(breaches.verdict).toBe('breaches');
    expect(breaches.after.lowestBalance).toBe(100);
    expect(breaches.headroom).toBe(-100);
    // The forecast alone was fine; only the scenario tips it.
    expect(breaches.before.lowestBalance).toBe(1000);
  });

  it('expands a recurring commitment across the horizon and caps it per occurrence', () => {
    const r = assessAffordability(base(), { label: 'Tutoring', amount: 400, date: '2026-01-20', recurrence: 'monthly' });
    // Jan 20, Feb 20, Mar 20 all land inside the 12-week horizon.
    expect(r.scenario).toEqual({ label: 'Tutoring', date: '2026-01-20', total: 1200, occurrences: 3, recurring: true });
    // 4000 −1000 −400 −1000 −400 −1000 −400 → −200 at the end.
    expect(r.after.lowestBalance).toBe(-200);
    expect(r.after.lowestBalanceWeek).toBe('2026-03-16');
    expect(r.verdict).toBe('breaches');
    // The tightest week is the third occurrence: (1000 − 200) / 3.
    expect(r.maxAffordable).toBeCloseTo(266.67, 2);
  });

  // A commitment the forecast never weighed must not come back as a yes. The
  // verdict has its own value so the panel can render a neutral chip instead of
  // the green "Yes" — an affirmative money answer with no evidence behind it.
  it('does not answer ok when the commitment lands beyond the horizon', () => {
    const r = assessAffordability(base(), { label: 'Summer camp', amount: 2000, date: '2026-09-01' });
    expect(r.verdict).not.toBe('ok');
    expect(r.verdict).toBe('not_assessed');
    expect(r.scenario.occurrences).toBe(0);
    expect(r.scenario.total).toBe(0);
    // The answer still says what was tried, so the panel never labels it with a
    // date the person has since edited in the form.
    expect(r.scenario.date).toBe('2026-09-01');
    expect(r.maxAffordable).toBeNull();
    expect(r.after).toEqual(r.before);
  });

  it('does not answer ok for a large commitment beyond the horizon either', () => {
    const r = assessAffordability({ ...base(), startingBalance: 300, buffer: 200 }, { label: 'Boat', amount: 50000, date: '2026-09-01' });
    expect(r.verdict).toBe('not_assessed');
    expect(r.scenario.occurrences).toBe(0);
  });

  it('reports maxAffordable 0 when the forecast already dips under the buffer without it', () => {
    const r = assessAffordability(base({ startingBalance: 500 }), { label: 'Anything', amount: 100, date: '2026-01-20' });
    expect(r.before.lowestBalance).toBe(500 - 3000);
    expect(r.verdict).toBe('breaches');
    expect(r.maxAffordable).toBe(0);
  });

  it('uses the buffer the caller sets, falling back to 200', () => {
    const strict = assessAffordability(base({ buffer: 800 }), { label: 'Bike', amount: 300, date: '2026-01-20' });
    expect(strict.buffer).toBe(800);
    expect(strict.verdict).toBe('breaches'); // 700 < 800
    const lax = assessAffordability(base({ buffer: undefined }), { label: 'Bike', amount: 300, date: '2026-01-20' });
    expect(lax.buffer).toBe(200);
    expect(lax.verdict).toBe('ok');
  });

  it('includes plan-linked commitments in the baseline it tries against', () => {
    const input = base({ plans: [{ label: 'Spring break', amount: 900, date: '2026-02-14', source: 'vacation' }] });
    const r = assessAffordability(input, { label: 'Bike', amount: 300, date: '2026-01-20' });
    // 4000 −1000 −300 −900 −1000 −1000 → 100 at Mar 9.
    expect(r.before.lowestBalance).toBe(100);
    expect(r.after.lowestBalance).toBe(-200);
    expect(r.verdict).toBe('breaches');
  });

  it('never leaks the scenario into the baseline or mutates the input', () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    assessAffordability(input, { label: 'Bike', amount: 900, date: '2026-01-20' });
    expect(JSON.stringify(input)).toBe(snapshot);
    const plain = buildCashflowTimeline(input);
    expect(plain.scenarioOutflow).toBe(0);
    expect(plain.weeks.flatMap((w) => w.moments).some((m) => m.kind === 'scenario')).toBe(false);
  });
});
