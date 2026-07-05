import { describe, it, expect } from 'vitest';
import { learnPlaybook, slug, DEFAULT_SUGGESTION_CAP, type PlaybookSignal } from '@/lib/playbook/learn';

describe('slug', () => {
  it('normalizes to a stable, lowercase, dash key', () => {
    expect(slug('  Taco  Night! ')).toBe('taco-night');
    expect(slug('Oat Milk')).toBe('oat-milk');
    expect(slug('---')).toBe('');
  });
});

describe('learnPlaybook', () => {
  it('suggests a go-to dinner only once the meal recurs enough', () => {
    expect(learnPlaybook([{ type: 'meal', name: 'Taco night', count: 2 }])).toHaveLength(0);
    const [s] = learnPlaybook([{ type: 'meal', name: 'Taco night', count: 5 }]);
    expect(s.label).toBe('Go-to dinner');
    expect(s.value).toBe('Taco night');
    expect(s.category).toBe('preference');
    expect(s.evidence).toContain('5');
    expect(s.confidence).toBe(90); // 50 + 5*8
  });

  it('suggests a grocery staple past its threshold and clamps confidence at 100', () => {
    expect(learnPlaybook([{ type: 'grocery', name: 'Oat milk', count: 3 }])).toHaveLength(0);
    const [s] = learnPlaybook([{ type: 'grocery', name: 'Oat milk', count: 20 }]);
    expect(s.label).toBe('Grocery staple');
    expect(s.confidence).toBe(100); // 45 + 20*5 = 145 -> clamped
  });

  it('attributes an explicit favorite to a member and uses the rating for confidence', () => {
    const [s] = learnPlaybook([
      { type: 'favorite', kind: 'Book', name: 'Goodnight Moon', memberId: 'm-1', rating: 5 },
    ]);
    expect(s.memberId).toBe('m-1');
    expect(s.label).toBe('Favorite book');
    expect(s.evidence).toBe('Rated 5/5');
    expect(s.confidence).toBe(95); // 55 + 5*8
    expect(s.signature).toContain('m-1');
  });

  it('treats a memberless favorite as a whole-family fact', () => {
    const [s] = learnPlaybook([{ type: 'favorite', kind: 'Restaurant', name: 'Luigi\'s' }]);
    expect(s.memberId).toBeNull();
    expect(s.evidence).toBe('Marked a family favorite');
    expect(s.signature.endsWith(':family')).toBe(true);
  });

  it('suggests an annual tradition once it has repeated across years', () => {
    expect(learnPlaybook([{ type: 'tradition', title: 'Beach trip', when: 'early July', years: 1 }])).toHaveLength(0);
    const [s] = learnPlaybook([{ type: 'tradition', title: 'Beach trip', when: 'early July', years: 3 }]);
    expect(s.category).toBe('date');
    expect(s.label).toBe('Family tradition');
    expect(s.confidence).toBe(85); // 55 + 3*10
  });

  it('collapses duplicate signatures to the highest-confidence instance', () => {
    const out = learnPlaybook([
      { type: 'meal', name: 'Taco Night', count: 3 },
      { type: 'meal', name: 'taco night', count: 6 }, // same slug, stronger
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(clampMeal(6));
  });

  it('sorts by confidence descending', () => {
    const out = learnPlaybook([
      { type: 'grocery', name: 'Coffee', count: 4 },        // 65
      { type: 'meal', name: 'Pizza', count: 5 },            // 90
      { type: 'favorite', kind: 'Show', name: 'Bluey' },    // 65
    ]);
    const confs = out.map((s) => s.confidence);
    expect(confs).toEqual([...confs].sort((a, b) => b - a));
    expect(out[0].value).toBe('Pizza');
  });

  it('caps the number of suggestions', () => {
    const many: PlaybookSignal[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'meal', name: `Meal ${i}`, count: 5,
    }));
    expect(learnPlaybook(many)).toHaveLength(DEFAULT_SUGGESTION_CAP);
    expect(learnPlaybook(many, { cap: 5 })).toHaveLength(5);
  });

  it('returns nothing for no signals', () => {
    expect(learnPlaybook([])).toEqual([]);
  });
});

function clampMeal(count: number) {
  return Math.max(0, Math.min(100, Math.round(50 + count * 8)));
}
