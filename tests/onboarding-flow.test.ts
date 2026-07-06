import { describe, it, expect } from 'vitest';
import {
  FLOW_STEPS, STEP_LABELS, isSkippable, nextStep, prevStep, progressPct,
  emptyDraft, serializeDraft, hydrateDraft, canContinue,
  suggestFamilyName, goalQuickstart, detectTimezone,
  type OnboardingDraft,
} from '@/lib/onboarding/flow';

describe('step machine', () => {
  it('orders the journey you → family → people → goals → pin → done', () => {
    expect(FLOW_STEPS).toEqual(['you', 'family', 'people', 'goals', 'pin', 'done']);
    expect(Object.keys(STEP_LABELS)).toHaveLength(6);
  });

  it('advances and retreats with clamping at the ends', () => {
    expect(nextStep('you')).toBe('family');
    expect(nextStep('pin')).toBe('done');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('family')).toBe('you');
    expect(prevStep('you')).toBe('you');
  });

  it('marks exactly people/goals/pin as skippable', () => {
    expect(FLOW_STEPS.filter(isSkippable)).toEqual(['people', 'goals', 'pin']);
  });

  it('progress rises monotonically and never reads 0', () => {
    const pcts = FLOW_STEPS.map(progressPct);
    expect(pcts[0]).toBeGreaterThan(0);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    expect(progressPct('pin')).toBe(100);
  });
});

describe('draft persistence', () => {
  it('round-trips a draft through serialize/hydrate', () => {
    const d: OnboardingDraft = {
      ...emptyDraft(), step: 'goals', fullName: 'Jordan Lee', familyName: 'The Lee Family',
      householdChildren: 2, childAges: [6, 9], goals: ['meals', 'chores'],
    };
    const back = hydrateDraft(serializeDraft(d));
    expect(back).toEqual(d);
  });

  it('never resumes onto the done step', () => {
    const d = { ...emptyDraft(), step: 'done' as const, fullName: 'A' };
    expect(hydrateDraft(serializeDraft(d))?.step).toBe('you');
  });

  it('rejects malformed / wrong-version payloads', () => {
    expect(hydrateDraft(null)).toBeNull();
    expect(hydrateDraft('not json')).toBeNull();
    expect(hydrateDraft(JSON.stringify({ version: 2, fullName: 'x' }))).toBeNull();
    expect(hydrateDraft(JSON.stringify({ fullName: 42 }))).toBeNull();
  });

  it('sanitizes array fields from hostile input', () => {
    const raw = JSON.stringify({ version: 1, fullName: 'A', childAges: ['x', 3], goals: [1, 'meals'], members: 'nope' });
    const d = hydrateDraft(raw)!;
    expect(d.childAges).toEqual([3]);
    expect(d.goals).toEqual(['meals']);
    expect(d.members).toEqual([]);
  });

  it('the draft shape has no pin field (never persisted)', () => {
    expect('pin' in emptyDraft()).toBe(false);
    expect(serializeDraft(emptyDraft())).not.toMatch(/pin/i);
  });
});

describe('gating', () => {
  it('you requires a name; family requires a 2+ char family name', () => {
    const d = emptyDraft();
    expect(canContinue('you', d)).toBe(false);
    expect(canContinue('you', { ...d, fullName: 'J' })).toBe(true);
    expect(canContinue('family', { ...d, familyName: 'A' })).toBe(false);
    expect(canContinue('family', { ...d, familyName: 'Us' })).toBe(true);
  });

  it('skippable steps always continue', () => {
    const d = emptyDraft();
    expect(canContinue('people', d)).toBe(true);
    expect(canContinue('goals', d)).toBe(true);
    expect(canContinue('pin', d)).toBe(true);
  });
});

describe('personalization', () => {
  it('suggests family names from full, first-only, and empty names', () => {
    expect(suggestFamilyName('Jordan Lee')).toBe('The Lee Family');
    expect(suggestFamilyName('Maria de la Cruz')).toBe('The de la Cruz Family');
    expect(suggestFamilyName('Jordan')).toBe("Jordan's Family");
    expect(suggestFamilyName('  ')).toBe('Our Family');
  });

  it('maps chosen goals to real deep-linked first actions, order-preserving', () => {
    const q = goalQuickstart(['meals', 'budget', 'nonsense']);
    expect(q.map((x) => x.goal)).toEqual(['meals', 'budget']);
    expect(q[0].href).toBe('/dashboard/meals');
    expect(q[1].href).toBe('/dashboard/budgets');
    expect(q.every((x) => x.label.length > 0 && x.icon.length > 0)).toBe(true);
  });

  it('caps the launchpad and falls back to a default trio when no goals picked', () => {
    expect(goalQuickstart(['chores', 'calendar', 'meals', 'groceries', 'budget'])).toHaveLength(4);
    const fallback = goalQuickstart([]);
    expect(fallback.map((x) => x.goal)).toEqual(['calendar', 'groceries', 'chores']);
  });

  it('detectTimezone returns the resolver value or UTC on failure', () => {
    expect(detectTimezone(() => 'America/Chicago')).toBe('America/Chicago');
    expect(detectTimezone(() => undefined)).toBe('UTC');
    expect(detectTimezone(() => { throw new Error('boom'); })).toBe('UTC');
  });
});
