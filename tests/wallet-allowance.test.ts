import { describe, it, expect } from 'vitest';
import { nextRunDate, isAllowanceDue, rollForward, dueAllowances } from '@/lib/wallet/allowance';

describe('nextRunDate', () => {
  it('advances weekly / biweekly by 7 / 14 days', () => {
    expect(nextRunDate('2026-06-24', 'weekly')).toBe('2026-07-01');
    expect(nextRunDate('2026-06-24', 'biweekly')).toBe('2026-07-08');
  });
  it('advances monthly to the same day next month', () => {
    expect(nextRunDate('2026-06-15', 'monthly')).toBe('2026-07-15');
  });
  it('clamps monthly to the last valid day', () => {
    expect(nextRunDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });
  it('rolls weekly across a month boundary', () => {
    expect(nextRunDate('2026-12-29', 'weekly')).toBe('2027-01-05');
  });
});

describe('isAllowanceDue', () => {
  it('is due when next run is on or before today', () => {
    expect(isAllowanceDue('2026-06-24', '2026-06-24')).toBe(true);
    expect(isAllowanceDue('2026-06-20', '2026-06-24')).toBe(true);
    expect(isAllowanceDue('2026-06-25', '2026-06-24')).toBe(false);
    expect(isAllowanceDue(null, '2026-06-24')).toBe(false);
  });
});

describe('rollForward', () => {
  it('pays once and schedules the next future run', () => {
    const r = rollForward('2026-06-24', 'weekly', '2026-06-24');
    expect(r.runs).toBe(1);
    expect(r.next).toBe('2026-07-01');
  });
  it('caps missed runs but still lands in the future', () => {
    // 8 weeks late, default cap 1 → pays once, next is in the future
    const r = rollForward('2026-05-01', 'weekly', '2026-06-24', 1);
    expect(r.runs).toBe(1);
    expect(r.next > '2026-06-24').toBe(true);
  });
  it('does not pay when not yet due', () => {
    const r = rollForward('2026-07-01', 'weekly', '2026-06-24');
    expect(r.runs).toBe(0);
    expect(r.next).toBe('2026-07-01');
  });
});

describe('dueAllowances', () => {
  const today = '2026-06-24';
  it('counts + sums only active, dated, positive rules that are due', () => {
    const r = dueAllowances([
      { isActive: true, nextRunOn: '2026-06-20', amountCents: 1000 }, // due
      { isActive: true, nextRunOn: '2026-06-24', amountCents: 500 },  // due (today)
      { isActive: true, nextRunOn: '2026-07-01', amountCents: 800 },  // not due yet
      { isActive: false, nextRunOn: '2026-06-01', amountCents: 900 }, // paused
      { isActive: true, nextRunOn: null, amountCents: 700 },          // no schedule
      { isActive: true, nextRunOn: '2026-06-10', amountCents: 0 },    // zero
    ], today);
    expect(r.count).toBe(2);
    expect(r.totalCents).toBe(1500);
  });
  it('is empty when nothing is due', () => {
    expect(dueAllowances([{ isActive: true, nextRunOn: '2026-07-01', amountCents: 1000 }], today)).toEqual({ count: 0, totalCents: 0 });
  });
});
