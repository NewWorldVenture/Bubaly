import { describe, it, expect } from 'vitest';
import {
  LADDER, AGE_BANDS, bandForAge, ageFromBirthday, suggestMilestones, independenceLevel,
  DOMAIN_LABEL,
} from '@/lib/independence/progression';

describe('LADDER content', () => {
  it('covers 3 milestones × 6 domains × 5 bands with unique titles', () => {
    expect(LADDER).toHaveLength(90);
    const titles = new Set(LADDER.map(m => m.title));
    expect(titles.size).toBe(90);
    for (const band of AGE_BANDS) {
      for (const domain of Object.keys(DOMAIN_LABEL)) {
        expect(LADDER.filter(m => m.ageBand === band && m.domain === domain)).toHaveLength(3);
      }
    }
  });
});

describe('bandForAge / ageFromBirthday', () => {
  it('maps ages to bands with clamping at the edges', () => {
    expect(bandForAge(3)).toBe('4-6');
    expect(bandForAge(8)).toBe('7-9');
    expect(bandForAge(12)).toBe('10-12');
    expect(bandForAge(15)).toBe('13-15');
    expect(bandForAge(19)).toBe('16-18');
  });

  it('computes age from a birthday and is safe on junk', () => {
    expect(ageFromBirthday('2016-07-01', new Date('2026-07-12T00:00:00Z'))).toBe(10);
    expect(ageFromBirthday('2016-08-01', new Date('2026-07-12T00:00:00Z'))).toBe(9); // not yet
    expect(ageFromBirthday(null)).toBeNull();
    expect(ageFromBirthday('nope')).toBeNull();
  });
});

describe('suggestMilestones', () => {
  it('offers everything at/below the band, foundations first, minus existing', () => {
    const existing = new Set(['Puts toys away']);
    const s = suggestMilestones(8, existing);
    // bands 4-6 + 7-9 = 36 milestones, minus 1 existing
    expect(s).toHaveLength(35);
    expect(s[0].ageBand).toBe('4-6');
    expect(s.map(m => m.title)).not.toContain('Puts toys away');
    expect(s.some(m => m.ageBand === '10-12')).toBe(false);
  });
});

describe('independenceLevel', () => {
  it('levels up as the eligible ladder is achieved', () => {
    const none = independenceLevel(8, new Set());
    expect(none.level).toBe(1);
    expect(none.eligibleCount).toBe(36);

    const all = independenceLevel(8, new Set(LADDER.filter(m => m.ageBand !== '16-18').map(m => m.title)));
    expect(all.pct).toBe(100);
    expect(all.level).toBe(5);
    expect(all.label).toBe('Almost-adult');
  });

  it('half-way lands mid-ladder with a next unlock', () => {
    const half = new Set(LADDER.filter(m => m.ageBand === '4-6').map(m => m.title));
    const l = independenceLevel(8, half);   // 18 of 36
    expect(l.pct).toBe(50);
    expect(l.level).toBe(3);
    expect(l.nextUnlock.length).toBeGreaterThan(10);
  });
});
