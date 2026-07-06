import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_FLOW, PROGRESS_STEPS, nextStep, prevStep, stepIndex, progressPct,
  stepCounter, suggestFamilyName, canAdvance, emptyDraft, buildFinalizePayload,
  isFirstStep, isLastFormStep, serializeDraftState, parseDraftState,
} from '@/lib/onboarding/flow';

describe('step navigation', () => {
  it('advances and clamps at the terminal step', () => {
    expect(nextStep('profile')).toBe('family');
    expect(nextStep('pin')).toBe('done');
    expect(nextStep('done')).toBe('done'); // clamp
  });

  it('goes back and clamps at the first step', () => {
    expect(prevStep('family')).toBe('profile');
    expect(prevStep('profile')).toBe('profile'); // clamp
  });

  it('knows the first and last form steps', () => {
    expect(isFirstStep('profile')).toBe(true);
    expect(isFirstStep('family')).toBe(false);
    expect(isLastFormStep('pin')).toBe(true);
    expect(isLastFormStep('about')).toBe(false);
  });

  it('exposes a monotonic progress percentage over the form steps', () => {
    const pcts = PROGRESS_STEPS.map(progressPct);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    expect(progressPct(PROGRESS_STEPS[PROGRESS_STEPS.length - 1])).toBe(100);
    expect(progressPct('done')).toBe(100);
  });

  it('reports a step counter that excludes the celebration step', () => {
    expect(stepCounter('profile')).toEqual({ current: 1, total: PROGRESS_STEPS.length });
    expect(stepIndex('done')).toBe(ONBOARDING_FLOW.length - 1);
  });
});

describe('suggestFamilyName', () => {
  it('builds a friendly family name from a first name', () => {
    expect(suggestFamilyName('Jordan')).toBe('The Jordan Family');
    expect(suggestFamilyName('  Alex Smith ')).toBe('The Alex Family'); // first token only
  });
  it('returns empty for a blank name', () => {
    expect(suggestFamilyName('')).toBe('');
    expect(suggestFamilyName('   ')).toBe('');
  });
});

describe('canAdvance', () => {
  it('requires a name on the profile step', () => {
    expect(canAdvance('profile', emptyDraft())).toBe(false);
    expect(canAdvance('profile', emptyDraft({ name: 'Jordan' }))).toBe(true);
  });
  it('requires a family name (>=2 chars) on the family step', () => {
    expect(canAdvance('family', emptyDraft({ familyName: 'A' }))).toBe(false);
    expect(canAdvance('family', emptyDraft({ familyName: 'The Kim Family' }))).toBe(true);
  });
  it('never blocks the optional about/members steps', () => {
    expect(canAdvance('about', emptyDraft())).toBe(true);
    expect(canAdvance('members', emptyDraft())).toBe(true);
  });
  it('allows skipping the PIN but blocks a partial/mismatched one', () => {
    expect(canAdvance('pin', emptyDraft({ pin: '', confirmPin: '' }))).toBe(true);
    expect(canAdvance('pin', emptyDraft({ pin: '12', confirmPin: '12' }))).toBe(false);
    expect(canAdvance('pin', emptyDraft({ pin: '1234', confirmPin: '4321' }))).toBe(false);
    expect(canAdvance('pin', emptyDraft({ pin: '1357', confirmPin: '1357' }))).toBe(true);
  });
});

describe('buildFinalizePayload', () => {
  it('maps a full draft to the finalize action input', () => {
    const draft = emptyDraft({
      name: 'Jordan', age: '34', color: '#7c6dff', avatarUrl: 'data:image/png;base64,xxx',
      familyName: 'The Jordan Family', timezone: 'America/New_York',
      adults: 2, children: 2, childAges: [8, 11],
      goals: ['chores', 'calendar'], referralSource: 'friend_family',
      members: [
        { id: 'm1', kind: 'local', name: 'Leo', email: '', role: 'child', color: '#f4996e' },
        { id: 'm2', kind: 'invite', name: '', email: 'sam@example.com', role: 'adult' },
      ],
      pin: '1357', confirmPin: '1357',
    });
    const p = buildFinalizePayload(draft);
    expect(p.profile.firstName).toBe('Jordan');
    expect(p.family).toEqual({ name: 'The Jordan Family', timezone: 'America/New_York' });
    expect(p.details.householdAdults).toBe(2);
    expect(p.details.childAges).toEqual([8, 11]);
    expect(p.details.goals).toEqual(['chores', 'calendar']);
    expect(p.members).toHaveLength(2);
    expect(p.members[1]).toEqual({ kind: 'invite', email: 'sam@example.com', role: 'adult' });
    expect(p.appearance).toEqual({ color: '#7c6dff', age: 34, avatarUrl: 'data:image/png;base64,xxx', pin: '1357' });
  });

  it('omits an invalid/incomplete PIN and falls back to a suggested family name', () => {
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim', pin: '12', confirmPin: '12' }));
    expect(p.appearance.pin).toBeUndefined();
    expect(p.family.name).toBe('The Kim Family');
    expect(p.appearance.age).toBeNull();
  });

  it('carries the signup last name through without asking again', () => {
    const p = buildFinalizePayload(emptyDraft({ name: 'Jordan', lastName: 'Smoke' }));
    expect(p.profile.firstName).toBe('Jordan');
    expect(p.profile.lastName).toBe('Smoke');
  });
});

describe('draft persistence (sessionStorage resume)', () => {
  it('round-trips a draft but never persists the PIN', () => {
    const draft = emptyDraft({
      name: 'Jordan', familyName: 'The Jordan Family', adults: 2, children: 1, childAges: [7],
      goals: ['chores'], pin: '1357', confirmPin: '1357',
    });
    const raw = serializeDraftState('about', draft, true);
    expect(raw).not.toContain('1357');
    const restored = parseDraftState(raw)!;
    expect(restored.step).toBe('about');
    expect(restored.familyNameTouched).toBe(true);
    expect(restored.draft.name).toBe('Jordan');
    expect(restored.draft.childAges).toEqual([7]);
    expect(restored.draft.goals).toEqual(['chores']);
    expect(restored.draft.pin).toBe('');       // never restored
    expect(restored.draft.confirmPin).toBe('');
  });

  it('returns null for junk, wrong version, or the terminal step', () => {
    expect(parseDraftState(null)).toBeNull();
    expect(parseDraftState('not json')).toBeNull();
    expect(parseDraftState(JSON.stringify({ v: 99, step: 'about', draft: {} }))).toBeNull();
    expect(parseDraftState(JSON.stringify({ v: 1, step: 'done', draft: {} }))).toBeNull();
    expect(parseDraftState(JSON.stringify({ v: 1, step: 'bogus', draft: {} }))).toBeNull();
  });

  it('fills missing fields from an empty draft (forward-compatible)', () => {
    const restored = parseDraftState(JSON.stringify({ v: 1, step: 'profile', draft: { name: 'Kim' } }))!;
    expect(restored.draft.name).toBe('Kim');
    expect(restored.draft.members).toEqual([]);
    expect(restored.draft.timezone).toBe('UTC');
  });
});
