import { describe, it, expect } from 'vitest';
import {
  summarizeActivation,
  sessionIndexFromMs,
  percentile,
  ACTIVATION_MILESTONES,
  type ActivationEventLike,
} from '@/lib/analytics/activation';

const DAY = 86_400_000;
const ev = (session_id: string, milestone: string, ms_since_signup: number | null, session_index = sessionIndexFromMs(ms_since_signup)): ActivationEventLike => ({
  session_id, milestone, ms_since_signup, session_index, created_at: '2026-07-01T00:00:00Z',
});

describe('sessionIndexFromMs', () => {
  it('within a day = session 1, within a week = 2, later = 3', () => {
    expect(sessionIndexFromMs(0)).toBe(1);
    expect(sessionIndexFromMs(DAY - 1)).toBe(1);
    expect(sessionIndexFromMs(2 * DAY)).toBe(2);
    expect(sessionIndexFromMs(10 * DAY)).toBe(3);
    expect(sessionIndexFromMs(null)).toBe(1);
  });
});

describe('percentile', () => {
  it('nearest-rank p90 and empty handling', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90);
    expect(percentile([5], 0.5)).toBe(5);
  });
});

describe('summarizeActivation', () => {
  it('empty → zeroed summary', () => {
    const s = summarizeActivation([]);
    expect(s.cohorts).toBe(0);
    expect(s.activationRate).toBe(0);
    expect(s.ttfvMedianMs).toBeNull();
    expect(s.ttfvP90Ms).toBeNull();
  });

  it('counts distinct cohorts and activation rate (reached first value)', () => {
    const s = summarizeActivation([
      ev('a', 'signup', 0), ev('a', 'first_outcome_viewed', 5 * 60_000),
      ev('b', 'signup', 0), // b never activates
      ev('c', 'signup', 0), ev('c', 'first_outcome_viewed', 15 * 60_000),
    ]);
    expect(s.cohorts).toBe(3);
    expect(s.activatedCohorts).toBe(2);
    expect(s.activationRate).toBeCloseTo(2 / 3, 5);
  });

  it('TTFV median/p90 use the EARLIEST first-value time per cohort', () => {
    const s = summarizeActivation([
      ev('a', 'first_outcome_viewed', 9 * 60_000),
      ev('a', 'first_outcome_viewed', 3 * 60_000), // earlier — should win
      ev('b', 'first_outcome_viewed', 7 * 60_000),
    ]);
    expect(s.ttfvMedianMs).toBe(5 * 60_000); // median of {3m, 7m}
    expect(s.ttfvP90Ms).toBe(7 * 60_000);
  });

  it('ignores negative/absent TTFV clocks', () => {
    const s = summarizeActivation([
      ev('a', 'first_outcome_viewed', -100),
      ev('b', 'first_outcome_viewed', null),
      ev('c', 'first_outcome_viewed', 4 * 60_000),
    ]);
    expect(s.activatedCohorts).toBe(3);       // all reached the milestone
    expect(s.ttfvMedianMs).toBe(4 * 60_000);  // but only c has a valid clock
  });

  it('session-1 rates count cohorts hitting a milestone in their first session', () => {
    const s = summarizeActivation([
      ev('a', 'calendar_imported', 60_000),        // session 1
      ev('b', 'calendar_imported', 3 * DAY),       // session 2 — not session 1
      ev('c', 'first_brief_viewed', 60_000),       // session 1
      ev('a', 'signup', 0), ev('b', 'signup', 0), ev('c', 'signup', 0),
    ]);
    expect(s.cohorts).toBe(3);
    expect(s.session1.calendarImportRate).toBeCloseTo(1 / 3, 5); // only a
    expect(s.session1.firstBriefRate).toBeCloseTo(1 / 3, 5);     // only c
  });

  it('reports per-milestone reach for every milestone', () => {
    const s = summarizeActivation([ev('a', 'signup', 0), ev('a', 'first_outcome_viewed', 60_000)]);
    expect(s.milestoneReach).toHaveLength(ACTIVATION_MILESTONES.length);
    const signup = s.milestoneReach.find((m) => m.key === 'signup')!;
    expect(signup.cohorts).toBe(1);
    expect(signup.rate).toBe(1);
    expect(s.milestoneReach.find((m) => m.key === 'first_capture')!.cohorts).toBe(0);
  });
});
