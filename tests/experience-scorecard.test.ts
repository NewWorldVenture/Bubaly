import { describe, it, expect } from 'vitest';
import {
  scoreAudit,
  gradeFor,
  rollUpScorecard,
  EXPERIENCE_DIMENSIONS,
  DIMENSION_KEYS,
  NEEDS_WORK_THRESHOLD,
  type AuditRecord,
  type DimensionScores,
} from '@/lib/experience/scorecard';

const audit = (surfaceKey: string, auditedOn: string, dimensions: DimensionScores, surfaceLabel = surfaceKey, category = 'module'): AuditRecord => ({
  surfaceKey, surfaceLabel, category, auditedOn, dimensions, score: scoreAudit(dimensions),
});

describe('scoreAudit', () => {
  it('all-equal dimensions → that value', () => {
    const dims = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 80]));
    expect(scoreAudit(dims)).toBe(80);
  });
  it('is weighted (error_recovery + a11y carry more)', () => {
    // Put 100 on the two heaviest dims, 0 elsewhere → above the unweighted 33.
    const heavy = scoreAudit({ error_recovery: 100, accessibility: 100 });
    expect(heavy).toBe(100); // only those two present → normalized to 100
  });
  it('partial audits normalize by present weights (missing ≠ zero)', () => {
    expect(scoreAudit({ empty_state: 90 })).toBe(90);
  });
  it('clamps out-of-range inputs', () => {
    expect(scoreAudit({ empty_state: 150, performance: -20 })).toBe(50); // (100+0)/2
  });
  it('empty → 0', () => {
    expect(scoreAudit({})).toBe(0);
  });
});

describe('gradeFor', () => {
  it('bands on 90/80/70/60', () => {
    expect(gradeFor(95)).toBe('A');
    expect(gradeFor(90)).toBe('A');
    expect(gradeFor(89)).toBe('B');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(70)).toBe('C');
    expect(gradeFor(60)).toBe('D');
    expect(gradeFor(59)).toBe('F');
  });
});

describe('rollUpScorecard', () => {
  const full = (v: number): DimensionScores => Object.fromEntries(DIMENSION_KEYS.map((k) => [k, v]));

  it('takes the LATEST audit per surface and computes movement vs the previous one', () => {
    const card = rollUpScorecard([
      audit('calendar', '2026-06-01', full(60)),
      audit('calendar', '2026-07-01', full(84)), // latest
      audit('tasks', '2026-07-01', full(92)),
    ]);
    const calendar = card.surfaces.find((s) => s.surfaceKey === 'calendar')!;
    expect(calendar.score).toBe(84);
    expect(calendar.grade).toBe('B');
    expect(calendar.delta).toBe(24); // 84 − 60
    expect(card.auditedSurfaces).toBe(2);
  });

  it('single-audit surfaces have a null delta', () => {
    const card = rollUpScorecard([audit('meals', '2026-07-01', full(75))]);
    expect(card.surfaces[0].delta).toBeNull();
    expect(card.overallDelta).toBeNull();
  });

  it('orders surfaces worst-first and flags those below the threshold', () => {
    const card = rollUpScorecard([
      audit('a', '2026-07-01', full(95)),
      audit('b', '2026-07-01', full(55)),
      audit('c', '2026-07-01', full(72)),
    ]);
    expect(card.surfaces.map((s) => s.surfaceKey)).toEqual(['b', 'c', 'a']);
    expect(card.needsWorkCount).toBe(1); // only b < 70
    expect(card.surfaces[0].needsWork).toBe(true);
    expect(NEEDS_WORK_THRESHOLD).toBe(70);
  });

  it('computes overall as the mean of latest surface scores + a grade', () => {
    const card = rollUpScorecard([
      audit('a', '2026-07-01', full(90)),
      audit('b', '2026-07-01', full(80)),
    ]);
    expect(card.overall).toBe(85);
    expect(card.overallGrade).toBe('B');
  });

  it('surfaces per-dimension averages and the weakest dimension first', () => {
    const card = rollUpScorecard([
      audit('a', '2026-07-01', { empty_state: 90, accessibility: 40, performance: 80 }),
      audit('b', '2026-07-01', { empty_state: 70, accessibility: 50, performance: 100 }),
    ]);
    const a11y = card.dimensionAverages.find((d) => d.key === 'accessibility')!;
    expect(a11y.average).toBe(45); // (40+50)/2
    expect(card.weakestDimensions[0]).toBe('accessibility');
  });

  it('empty input → zeroed scorecard', () => {
    const card = rollUpScorecard([]);
    expect(card.overall).toBe(0);
    expect(card.overallGrade).toBe('F');
    expect(card.surfaces).toEqual([]);
    expect(card.needsWorkCount).toBe(0);
  });

  it('rubric weights are all positive and every dimension has a label', () => {
    for (const d of EXPERIENCE_DIMENSIONS) {
      expect(d.weight).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });
});
