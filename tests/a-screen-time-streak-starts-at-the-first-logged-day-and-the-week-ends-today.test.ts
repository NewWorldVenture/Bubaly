// The Screen Time card shows a flame "Nd under" streak and a "this week" total.
// The streak counted every day with no entry as under the limit and never
// stopped, so a member with a limit and no over-limit day in the past year read
// "366d under" the moment a limit was set, with nothing logged at all. And the
// week had no upper bound, so an entry dated in the future (the date input
// allowed one) was added to this week and to the balance score
// (LIBRARY-1C237C551BED).
import { describe, expect, it } from 'vitest';
import { balanceScore, minutesInWindow, underLimitStreak, type ScreenEntryLike } from '@/lib/screen-time/insights';

const e = (entry_date: string, minutes: number, category = 'gaming'): ScreenEntryLike =>
  ({ member_id: 'm1', entry_date, minutes, category });

const TODAY = '2026-06-24'; // the family's day

describe('a screen-time streak starts at the first logged day', () => {
  it('is zero for a member with a limit and nothing logged', () => {
    expect(underLimitStreak([], 120, TODAY)).toBe(0);
  });

  it('counts back to the earliest logged day and no further', () => {
    // First log was two days ago: three days under, not 366.
    expect(underLimitStreak([e('2026-06-22', 60)], 120, TODAY)).toBe(3);
    expect(underLimitStreak([e('2026-06-24', 60)], 120, TODAY)).toBe(1);
    // A quiet day between two logs still counts as under the limit.
    expect(underLimitStreak([e('2026-06-24', 30), e('2026-06-20', 30)], 120, TODAY)).toBe(5);
  });

  it('still stops at the first over-limit day', () => {
    const entries = [e('2026-06-24', 100), e('2026-06-23', 90), e('2026-06-22', 200), e('2026-06-01', 10)];
    expect(underLimitStreak(entries, 120, TODAY)).toBe(2);
    expect(underLimitStreak([e('2026-06-24', 121)], 120, TODAY)).toBe(0);
  });

  it('never runs past a year however old the first log is', () => {
    expect(underLimitStreak([e('2020-01-01', 10)], 120, TODAY)).toBe(366);
  });

  it('a future-dated entry neither starts a streak nor counts in it', () => {
    expect(underLimitStreak([e('2026-06-30', 60)], 120, TODAY)).toBe(0);
    expect(underLimitStreak([e('2026-06-30', 500), e('2026-06-23', 60)], 120, TODAY)).toBe(2);
  });
});

describe('the screen-time week ends today', () => {
  const entries = [e('2026-06-24', 30), e('2026-06-18', 20), e('2026-06-17', 999), e('2026-06-25', 45), e('2026-07-10', 600)];

  it('leaves a future-dated entry out of this week', () => {
    expect(minutesInWindow(entries, 7, TODAY)).toBe(50); // the 18th..24th
    expect(minutesInWindow(entries, 1, TODAY)).toBe(30);
    expect(minutesInWindow([e('2026-06-25', 45)], 7, TODAY)).toBe(0);
  });

  it("leaves it out of the week's balance score, selected the way the card selects it", () => {
    const week = [e('2026-06-24', 30, 'educational'), e('2026-06-26', 90, 'gaming')];
    const inWeek = week.filter((row) => minutesInWindow([row], 7, TODAY) > 0);
    expect(inWeek.map((row) => row.entry_date)).toEqual(['2026-06-24']);
    expect(balanceScore(inWeek)).toBe(100);
  });
});
