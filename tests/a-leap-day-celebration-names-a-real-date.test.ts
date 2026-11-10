import { describe, it, expect } from 'vitest';
import { upcomingCelebrations } from '@/lib/celebrations/dates';

describe('a 29 February celebration in a common year', () => {
  it('reports the 1 March it is counted to, not the date that does not exist', () => {
    const from = new Date(2027, 1, 20); // 2027-02-20 local; 2027 is not a leap year
    const [leap] = upcomingCelebrations([
      { id: 'l', kind: 'birthday', title: 'Leapling', date: '2024-02-29' },
    ], 30, from);
    expect(leap.daysUntil).toBe(9);
    expect(leap.nextDate).toBe('2027-03-01');
    expect(Number.isNaN(Date.parse(`${leap.nextDate}T12:00:00Z`))).toBe(false);
  });
});
