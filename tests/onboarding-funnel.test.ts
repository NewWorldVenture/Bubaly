import { describe, it, expect } from 'vitest';
import {
  summarizeOnboardingFunnel, median, formatDuration, formatRate,
  type OnboardingEventLike,
} from '@/lib/analytics/onboarding';

// Three sessions through the NEW journey (you → family → people → goals → pin →
// done): s1 completes, s2 drops after people, s3 drops immediately.
const ev = (session_id: string, step: string, phase: string, duration_ms = 0): OnboardingEventLike =>
  ({ session_id, step, phase, duration_ms, created_at: '2026-07-01T00:00:00Z' });

const events: OnboardingEventLike[] = [
  ev('s1', 'you', 'started'),
  ev('s1', 'family', 'step', 3000),
  ev('s1', 'people', 'step', 6000),
  ev('s1', 'goals', 'step', 8000),
  ev('s1', 'pin', 'step', 10000),
  ev('s1', 'done', 'completed', 12000),
  ev('s2', 'you', 'started'),
  ev('s2', 'family', 'step', 4000),
  ev('s2', 'people', 'step', 7000),
  ev('s3', 'you', 'started'),
];

describe('summarizeOnboardingFunnel', () => {
  it('counts distinct sessions reaching each step of the new journey', () => {
    const f = summarizeOnboardingFunnel(events);
    const byKey = Object.fromEntries(f.steps.map((s) => [s.key, s.reached]));
    expect(byKey).toEqual({ you: 3, family: 2, people: 2, goals: 1, pin: 1, done: 1 });
  });

  it('buckets legacy "profile" rows under the new "you" step (alias)', () => {
    const legacy: OnboardingEventLike[] = [
      ev('old1', 'profile', 'started'),
      ev('new1', 'you', 'started'),
    ];
    const f = summarizeOnboardingFunnel(legacy);
    expect(f.steps.find((s) => s.key === 'you')!.reached).toBe(2);
  });

  it('computes reach rate relative to the first step', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.steps.find((s) => s.key === 'family')!.reachRate).toBeCloseTo(2 / 3, 5);
    expect(f.steps.find((s) => s.key === 'done')!.reachRate).toBeCloseTo(1 / 3, 5);
  });

  it('computes drop-off between consecutive steps', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.steps.find((s) => s.key === 'family')!.droppedFromPrev).toBe(1); // 3 → 2
    expect(f.steps.find((s) => s.key === 'goals')!.droppedFromPrev).toBe(1);  // 2 → 1
    expect(f.steps.find((s) => s.key === 'pin')!.droppedFromPrev).toBe(0);    // 1 → 1
    expect(f.steps.find((s) => s.key === 'you')!.droppedFromPrev).toBe(0);
  });

  it('computes started / completed / completion rate', () => {
    const f = summarizeOnboardingFunnel(events);
    expect(f.startedSessions).toBe(3);
    expect(f.completedSessions).toBe(1);
    expect(f.completionRate).toBeCloseTo(1 / 3, 5);
  });

  it('counts reaching the terminal step as completion even without a completed phase', () => {
    const evs: OnboardingEventLike[] = [ev('x', 'you', 'started'), ev('x', 'done', 'step', 9000)];
    expect(summarizeOnboardingFunnel(evs).completedSessions).toBe(1);
  });

  it('reports the biggest drop-off step', () => {
    // 5 sessions start, only 1 makes it to family → family is the cliff.
    const evs: OnboardingEventLike[] = [
      ...['a', 'b', 'c', 'd', 'e'].map((s) => ev(s, 'you', 'started')),
      ev('a', 'family', 'step', 1),
    ];
    expect(summarizeOnboardingFunnel(evs).biggestDropStep).toBe('family');
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
