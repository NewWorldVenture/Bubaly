import { describe, it, expect } from 'vitest';
import { nextBirthdayDate, daysUntil, upcomingBirthdayEvents, type BirthdayMember } from '@/lib/moments/birthdays';
import { buildMomentPrep } from '@/lib/moments/prep';

const now = new Date('2026-07-04T10:00:00');

describe('nextBirthdayDate', () => {
  it('picks this year when the day is still ahead, next year when it has passed', () => {
    expect(nextBirthdayDate('2015-08-10', now)?.getFullYear()).toBe(2026);
    expect(nextBirthdayDate('2015-01-10', now)?.getFullYear()).toBe(2027);
  });
  it('treats today as the next birthday (0 days)', () => {
    const d = nextBirthdayDate('2010-07-04', now)!;
    expect(daysUntil(d, now)).toBe(0);
  });
  it('rejects junk', () => {
    expect(nextBirthdayDate('not-a-date', now)).toBeNull();
  });
});

describe('upcomingBirthdayEvents', () => {
  const members: BirthdayMember[] = [
    { id: 'a', display_name: 'Mia Rivera', birthday: '2018-07-10' }, // in 6 days, turns 8
    { id: 'b', display_name: 'Dad', birthday: '1985-12-25' },        // far away
    { id: 'c', display_name: 'Old', birthday: '2000-06-01', is_active: false }, // inactive
    { id: 'd', display_name: 'NoBday', birthday: null },
    { id: 'e', display_name: 'Sam Lee', birthday: '2019-07-25' },    // in 21 days
  ];
  it('keeps only active members within the horizon, soonest first, with turning age', () => {
    const events = upcomingBirthdayEvents(members, now, 30);
    expect(events.map((e) => e.id)).toEqual(['birthday:a', 'birthday:e']);
    expect(events[0].title).toBe('Mia turns 8');
    expect(events[0].category).toBe('birthday');
    expect(events[0].all_day).toBe(true);
  });
  it('a synthetic birthday flows through buildMomentPrep as a celebration', () => {
    const [mia] = upcomingBirthdayEvents(members, now, 30);
    const prep = buildMomentPrep(mia, { now });
    expect(prep.category).toBe('celebration');
    expect(prep.items.find((i) => i.id === 'shop')?.groceryItems).toContain('Cake');
    expect(prep.items.find((i) => i.id === 'budget')).toBeTruthy();
  });
});
