import { describe, it, expect } from 'vitest';
import {
  computeMemberTraits, confidenceAdjustment, clampConfidence, clampUrgency,
  MIN_SAMPLE, type MemberTraits,
} from '@/lib/autopilot/twin';

describe('computeMemberTraits', () => {
  it('derives completion rate + reliability from chore history', () => {
    const [t] = computeMemberTraits([{ memberId: 'm1', choresCompleted: 8, choresTotal: 10 }]);
    expect(t.choreCompletionRate).toBe(0.8);
    expect(t.reliabilityScore).toBe(80);
    expect(t.sampleSize).toBe(10);
  });
  it('treats no history as fully reliable (no nagging by default)', () => {
    const [t] = computeMemberTraits([{ memberId: 'm1', choresCompleted: 0, choresTotal: 0 }]);
    expect(t.choreCompletionRate).toBe(1);
    expect(t.reliabilityScore).toBe(100);
  });
});

describe('confidenceAdjustment', () => {
  const forgetful: MemberTraits = { memberId: 'm1', choreCompletionRate: 0.3, reliabilityScore: 30, sampleSize: 10 };
  const dependable: MemberTraits = { memberId: 'm2', choreCompletionRate: 0.95, reliabilityScore: 95, sampleSize: 10 };
  const thin: MemberTraits = { memberId: 'm3', choreCompletionRate: 0.2, reliabilityScore: 20, sampleSize: 2 };

  it('nudges a forgetful member harder on chores', () => {
    expect(confidenceAdjustment(forgetful, 'chore')).toEqual({ confidenceDelta: 8, urgencyDelta: 1 });
  });
  it('eases off a dependable member on chores', () => {
    expect(confidenceAdjustment(dependable, 'chore')).toEqual({ confidenceDelta: -4, urgencyDelta: -1 });
  });
  it('bumps appointments/medications for an unreliable member', () => {
    expect(confidenceAdjustment(forgetful, 'appointment')).toEqual({ confidenceDelta: 5, urgencyDelta: 1 });
    expect(confidenceAdjustment(forgetful, 'medication')).toEqual({ confidenceDelta: 5, urgencyDelta: 1 });
  });
  it('does nothing without enough history or without traits', () => {
    expect(confidenceAdjustment(thin, 'chore')).toEqual({ confidenceDelta: 0, urgencyDelta: 0 });
    expect(confidenceAdjustment(undefined, 'chore')).toEqual({ confidenceDelta: 0, urgencyDelta: 0 });
    expect(thin.sampleSize).toBeLessThan(MIN_SAMPLE);
  });
  it('leaves unrelated kinds unchanged', () => {
    expect(confidenceAdjustment(forgetful, 'groceries')).toEqual({ confidenceDelta: 0, urgencyDelta: 0 });
  });
});

describe('clamps', () => {
  it('keeps confidence in 0..100 and urgency in 1..3', () => {
    expect(clampConfidence(140)).toBe(100);
    expect(clampConfidence(-5)).toBe(0);
    expect(clampUrgency(0)).toBe(1);
    expect(clampUrgency(5)).toBe(3);
    expect(clampUrgency(2)).toBe(2);
  });
});
