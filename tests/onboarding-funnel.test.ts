import { describe, it, expect } from 'vitest';
import {
  summarizeOnboardingFunnel, median, formatDuration, formatRate,
  type OnboardingEventLike,
} from '@/lib/analytics/onboarding';

// 3 sessions through the 6-step flow (profile → family → about → members → pin →
// done): s1 completes, s2 drops at pin, s3 drops at profile.
const events: OnboardingEventLike[] = [
  { session_id: 's1', step: 'profile', phase: 'started', duration_ms: 0, created_at: '2026-07-01T00:00:00Z' },
  { session_id: 's1', step: 'family', phase: 'step', duration_ms: 2000, created_at: '2026-07-01T00:00:02Z' },
  { session_id: 's1', step: 'about', phase: 'step', duration_ms: 4000, created_at: '2026-07-01T00:00:04Z' },
  { session_id: 's1', step: 'members', phase: 'step', duration_ms: 6000, created_at: '2026-07-01T00:00:06Z' },
  { session_id: 's1', step: 'pin', phase: 'step', duration_ms: 8000, created_at: '2026-07-01T00:00:08Z' },
  { session_id: 's1', step: 'done', phase: 'completed', duration_ms: 12000, created_at: '2026-07-01T00:00:12Z' },
  { session_id: 's2', step: 'profile', phase: 'started', duration_ms: 0, created_at: '2026-07-01T00:01:00Z' },
  { session_id: 's2', step: 'family', phase: 'step', duration_ms: 2000, created_at: '2026-07-01T00:01:02Z' },
  { session_id: 's2', step: 'about', phase: 'step', duration_ms: 4000, created_at: '2026-07-01T00:01:04Z' },
  { session_id: 's2', step: 'members', phase: 'step', duration_ms: 6000, created_at: '2026-07-01T00:01:06Z' },
  { session_id: 's2', step: 'pin', phase: 'step', duration_ms: 8000, created_at: '2026-07-01T00:01:08Z' },
  { session_id: 's3', step: 'profile', phase: 'started', duration_ms: 0, created_at: '2026-07-01T00:02:00Z' },
];

describe('summarizeOnboardingFunnel', () => {
  it('counts distinct sessions reaching each step', () => {
    const f = summarizeOnboardingFunnel(events);
    const byKey = Object.fromEntries(f.steps.map((s) => [s.key, s.reached]));
    expect(byKey).toEqual({ profile: 3, family: 2, about: 2, members: 2, pin: 2, done: 1 });
  });

  it('computes reach rate relative to the first step', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.steps.find((s) => s.key === 'pin')!.reachRate).toBeCloseTo(2 / 3, 5);
    expect(f.steps.find((s) => s.key === 'done')!.reachRate).toBeCloseTo(1 / 3, 5);
  });

  it('computes drop-off between consecutive steps', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.steps.find((s) => s.key === 'family')!.droppedFromPrev).toBe(1); // 3 → 2
    expect(f.steps.find((s) => s.key === 'done')!.droppedFromPrev).toBe(1);   // 2 → 1
    expect(f.steps.find((s) => s.key === 'profile')!.droppedFromPrev).toBe(0);
  });

  it('computes started / completed / completion rate', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.startedSessions).toBe(3);
    expect(f.completedSessions).toBe(1);
    expect(f.completionRate).toBeCloseTo(1 / 3, 5);
  });

  it('counts reaching the terminal step as completion even without a completed phase', () => {
    const evs: OnboardingEventLike[] = [
      { session_id: 'x', step: 'profile', phase: 'started', duration_ms: 0, created_at: '2026-07-01T00:00:00Z' },
      { session_id: 'x', step: 'done', phase: 'step', duration_ms: 9000, created_at: '2026-07-01T00:00:09Z' },
    ];
    expect(summarizeOnboardingFunnel(evs).completedSessions).toBe(1);
  });

  it('reports the biggest drop-off step', () => {
    // 5 sessions reach through `members`, only 1 reaches `pin` → members→pin is the biggest drop.
    const sessions = ['a', 'b', 'c', 'd', 'e'];
    const evs: OnboardingEventLike[] = [];
    for (const s of sessions) {
      for (const step of ['profile', 'family', 'about', 'members']) {
        evs.push({ session_id: s, step, phase: step === 'profile' ? 'started' : 'step', duration_ms: 0, created_at: '2026-07-01T00:00:00Z' });
      }
    }
    evs.push({ session_id: 'a', step: 'pin', phase: 'step', duration_ms: 1, created_at: '2026-07-01T00:00:01Z' });
    expect(summarizeOnboardingFunnel(evs).biggestDropStep).toBe('pin');
  });

  it('takes the median completion time', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.medianCompletionMs).toBe(12000);
  });

  it('handles an empty event set without dividing by zero', () => {
    const f = summarizeOnboardingFunnel([]);
    expect(f.startedSessions).toBe(0);
    expect(f.completionRate).toBe(0);
    expect(f.medianCompletionMs).toBeNull();
    expect(f.steps.every((s) => s.reached === 0)).toBe(true);
  });
});

describe('helpers', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });
  it('formatRate', () => { expect(formatRate(0.5)).toBe('50%'); });
});
