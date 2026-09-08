import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_FLOW, PROGRESS_STEPS, nextStep, prevStep, stepIndex, progressPct,
  stepCounter, suggestFamilyName, canAdvance, emptyDraft, buildFinalizePayload,
  isFirstStep, isLastFormStep, serializeDraftState, parseDraftState,
} from '@/lib/onboarding/flow';
import { onboardingFacts } from '@/lib/onboarding/facts';
import { buildOutcomePlan, pickFirstThing } from '@/lib/outcomes/launcher';

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

  it('puts the value step right after family (value-first sequencing)', () => {
    expect(nextStep('family')).toBe('value');
    expect(nextStep('value')).toBe('about');
    expect(prevStep('value')).toBe('family');
    // The value payoff comes BEFORE the deferrable configure steps.
    expect(ONBOARDING_FLOW.indexOf('value')).toBeLessThan(ONBOARDING_FLOW.indexOf('members'));
    expect(ONBOARDING_FLOW.indexOf('value')).toBeLessThan(ONBOARDING_FLOW.indexOf('pin'));
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
  it('never blocks the optional value/about/members steps', () => {
    expect(canAdvance('value', emptyDraft())).toBe(true); // importing is optional
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

  it('never records a phantom child age for a no-kids family', () => {
    // Regression: the old fallback parsed the kid COUNT as an age, so a
    // children:0 draft recorded child_ages [0] — one phantom infant.
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim', children: 0, childAges: [] }));
    expect(p.details.childAges).toEqual([]);
    expect(p.details.householdChildren).toBe(0);
  });

  it('drops 0 placeholder ages from the Kids stepper (0 = "not provided" in this UI)', () => {
    // Stepper pre-fills unanswered age slots with 0; the age input renders 0 as
    // an empty field, so a real 0 can't be expressed and must not persist.
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim', children: 3, childAges: [0, 7, 0] }));
    expect(p.details.childAges).toEqual([7]);
    expect(p.details.householdChildren).toBe(3); // the count is still truthful
  });

  it('clamps and drops out-of-range ages', () => {
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim', children: 2, childAges: [22, 5] }));
    expect(p.details.childAges).toEqual([5]); // 22 exceeds the 21 schema max
  });

  it('carries the imported calendar (source + capped events) into the payload', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ title: `E${i}`, start: `2026-07-07T0${i}:00:00.000Z` }));
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim', importSource: 'demo', importedEvents: events }));
    expect(p.calendarImport.source).toBe('demo');
    expect(p.calendarImport.events).toHaveLength(5);
  });

  it('defaults to no calendar import when the value step is skipped', () => {
    const p = buildFinalizePayload(emptyDraft({ name: 'Kim' }));
    expect(p.calendarImport).toEqual({ source: '', events: [] });
  });
});

describe('draft persistence never stashes imported events (quota safety)', () => {
  it('strips importedEvents from sessionStorage and restores them empty', () => {
    const events = Array.from({ length: 300 }, (_, i) => ({ title: `E${i}`, start: '2026-07-07T09:00:00.000Z' }));
    const draft = emptyDraft({ name: 'Kim', familyName: 'The Kim Family', importSource: 'demo', importedEvents: events });
    const raw = serializeDraftState('value', draft, true);
    expect(raw).not.toContain('E299');
    const restored = parseDraftState(raw);
    expect(restored?.draft.importedEvents).toEqual([]);
    expect(restored?.draft.importSource).toBe('');
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

// M30 — the wizard's answers reach memory, and its last screen hands the family
// into something real. Both are driven from what the draft already carries, so
// they are pinned here beside the draft rather than in isolation.
describe('the draft feeds family memory (M30)', () => {
  it('turns the answers the wizard collected into facts', () => {
    const draft = emptyDraft({
      name: 'Jordan', familyName: 'The Jordan Family',
      adults: 2, children: 2, childAges: [6, 9], goals: ['meals', 'chores'],
    });
    const { details } = buildFinalizePayload(draft);
    const facts = onboardingFacts({
      householdAdults: details.householdAdults,
      householdChildren: details.householdChildren,
      childAges: details.childAges,
      region: details.region ?? null,
      country: details.country ?? null,
      goals: details.goals,
    });
    expect(facts.map((f) => f.key)).toEqual(['Household size', 'Children’s ages', 'What this family wants help with']);
    expect(facts[0].content).toBe('2 adults and 2 children');
  });

  it('remembers nothing from a wizard run that skipped the About step', () => {
    const draft = emptyDraft({ name: 'Kim', familyName: 'The Kim Family', adults: 0, children: 0 });
    const { details } = buildFinalizePayload(draft);
    expect(onboardingFacts({
      householdAdults: details.householdAdults,
      householdChildren: details.householdChildren,
      childAges: details.childAges,
      goals: details.goals,
    })).toEqual([]);
  });

  it('drops the placeholder zero ages the payload already filters', () => {
    const draft = emptyDraft({ name: 'Kim', familyName: 'The Kim Family', adults: 2, children: 2, childAges: [0, 8] });
    const { details } = buildFinalizePayload(draft);
    expect(details.childAges).toEqual([8]);
    const facts = onboardingFacts({
      householdAdults: details.householdAdults,
      householdChildren: details.householdChildren,
      childAges: details.childAges,
      goals: details.goals,
    });
    expect(facts.find((f) => f.key === 'Children’s ages')?.content).toBe('8');
  });
});

describe('the done screen offers one real thing to do (M30)', () => {
  it('points at today when the family has a day to look at', () => {
    const thing = pickFirstThing({ eventsToday: 3, overdueTasks: 0, openGrocery: 0, birthdaysSoon: 0 });
    expect(thing.reason).toBe('events');
    expect(thing.outcomeId).toBe('run_today');
    expect(thing.href).toBe(buildOutcomePlan('run_today')[0].href);
  });

  it('prefers what is overdue over what is merely scheduled', () => {
    const thing = pickFirstThing({ eventsToday: 3, overdueTasks: 2, openGrocery: 4, birthdaysSoon: 1 });
    expect(thing.reason).toBe('overdue');
    expect(thing.href).toBe(buildOutcomePlan('run_today')[1].href);
  });

  it('falls through to the shopping list, then a birthday', () => {
    expect(pickFirstThing({ eventsToday: 0, overdueTasks: 0, openGrocery: 4, birthdaysSoon: 1 }).reason).toBe('grocery');
    expect(pickFirstThing({ eventsToday: 0, overdueTasks: 0, openGrocery: 0, birthdaysSoon: 1 }).reason).toBe('birthday');
  });

  it('still offers something to a family whose data is empty', () => {
    const thing = pickFirstThing();
    expect(thing.reason).toBe('default');
    expect(thing.href.startsWith('/')).toBe(true);
  });

  it('always lands on a step of the outcome it names — never an invented route', () => {
    const snapshots = [
      { eventsToday: 0, overdueTasks: 0, openGrocery: 0, birthdaysSoon: 0 },
      { eventsToday: 1, overdueTasks: 0, openGrocery: 0, birthdaysSoon: 0 },
      { eventsToday: 0, overdueTasks: 1, openGrocery: 0, birthdaysSoon: 0 },
      { eventsToday: 0, overdueTasks: 0, openGrocery: 1, birthdaysSoon: 0 },
      { eventsToday: 0, overdueTasks: 0, openGrocery: 0, birthdaysSoon: 1 },
    ];
    for (const ctx of snapshots) {
      const thing = pickFirstThing(ctx);
      expect(buildOutcomePlan(thing.outcomeId, ctx).map((s) => s.href)).toContain(thing.href);
      expect(thing.labelKey.startsWith('doOneThing.')).toBe(true);
      expect(thing.detailKey.startsWith('doOneThing.')).toBe(true);
    }
  });
});
