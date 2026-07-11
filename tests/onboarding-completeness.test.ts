import { describe, it, expect } from 'vitest';
import {
  computeCompleteness, statusFromCompleteness, type CompletenessSignals,
} from '@/lib/onboarding/completeness';

// A fully-onboarded wizard graduate.
const complete: CompletenessSignals = {
  hasName: true, hasFamily: true, hasQuestionnaire: true, hasGoals: true,
  valueEngaged: true, memberCount: 2, hasPin: true, source: 'wizard', status: 'completed',
};

// The classic auto-provisioned account: has a space, nothing else.
const autoProvisioned: CompletenessSignals = {
  hasName: true, hasFamily: true, hasQuestionnaire: false, hasGoals: false,
  valueEngaged: false, memberCount: 0, hasPin: false, source: 'auto_provision', status: 'in_progress',
};

describe('computeCompleteness — score', () => {
  it('scores a fully set-up account 100 with nothing missing', () => {
    const r = computeCompleteness(complete);
    expect(r.score).toBe(100);
    expect(r.missing).toEqual([]);
    expect(r.isComplete).toBe(true);
    expect(r.needsSetup).toBe(false);
    expect(r.needsReset).toBe(false);
  });

  it('score is clamped 0..100', () => {
    const none: CompletenessSignals = {
      hasName: false, hasFamily: false, hasQuestionnaire: false, hasGoals: false,
      valueEngaged: false, memberCount: 0, hasPin: false, source: 'auto_provision',
    };
    const r = computeCompleteness(none);
    expect(r.score).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('partial credit: name + members only', () => {
    const r = computeCompleteness({
      hasName: true, hasFamily: true, hasQuestionnaire: false, hasGoals: false,
      valueEngaged: false, memberCount: 3, hasPin: false, source: 'wizard',
    });
    // name (15) + members (15) = 30
    expect(r.score).toBe(30);
  });
});

describe('computeCompleteness — missing pieces', () => {
  it('lists missing pieces highest-weight first', () => {
    const r = computeCompleteness(autoProvisioned);
    const keys = r.missing.map((m) => m.key);
    // questionnaire (25) must come before goals (15) / members (15) / pin (10),
    // and value (20) before goals.
    expect(keys[0]).toBe('questionnaire');
    expect(keys.indexOf('value')).toBeLessThan(keys.indexOf('goals'));
    // Every missing piece carries a destination.
    for (const m of r.missing) expect(m.href.length).toBeGreaterThan(0);
  });

  it('every missing weight is descending', () => {
    const r = computeCompleteness(autoProvisioned);
    for (let i = 1; i < r.missing.length; i++) {
      expect(r.missing[i - 1].weight).toBeGreaterThanOrEqual(r.missing[i].weight);
    }
  });
});

describe('computeCompleteness — cohorts', () => {
  it('flags the auto-provisioned account as needsSetup, not complete', () => {
    const r = computeCompleteness(autoProvisioned);
    expect(r.isComplete).toBe(false);
    expect(r.needsSetup).toBe(true);
    expect(r.needsReset).toBe(false);
    expect(r.headline).toMatch(/finish/i);
  });

  it('a completed questionnaire is "complete" even without a PIN or value step', () => {
    const r = computeCompleteness({
      hasName: true, hasFamily: true, hasQuestionnaire: true, hasGoals: true,
      valueEngaged: false, memberCount: 0, hasPin: false, source: 'wizard', status: 'completed',
    });
    expect(r.isComplete).toBe(true);
    expect(r.needsSetup).toBe(false);
    // …but the optional pieces still cost score, so the nudge can still surface.
    expect(r.score).toBeLessThan(100);
  });

  it('reset status wins — needsReset regardless of source', () => {
    const r = computeCompleteness({ ...complete, status: 'reset' });
    expect(r.needsReset).toBe(true);
    expect(r.needsSetup).toBe(false);
    expect(r.headline).toMatch(/again/i);
  });
});

describe('statusFromCompleteness', () => {
  it('maps complete → completed, incomplete → in_progress, reset → reset', () => {
    expect(statusFromCompleteness(computeCompleteness(complete))).toBe('completed');
    expect(statusFromCompleteness(computeCompleteness(autoProvisioned))).toBe('in_progress');
    expect(statusFromCompleteness(computeCompleteness({ ...complete, status: 'reset' }))).toBe('reset');
  });
});
