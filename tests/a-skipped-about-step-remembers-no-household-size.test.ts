import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFinalizePayload, emptyDraft, parseDraftState, serializeDraftState, type OnboardingDraft,
} from '@/lib/onboarding/flow';
import { onboardingFacts } from '@/lib/onboarding/facts';
import { finalizeOnboardingSchema } from '@/lib/validation';
import { at, bodyOf } from './helpers/source-order';

// LIBRARY-42CA2FF62811. The About step opens on "Adults: 1" (the draft is
// seeded with it and the stepper cannot go below 1), and "Skip for now" just
// moved on. So a family that skipped the question still arrived at finalize as
// 1 adult and 0 children, and onboardingFacts, whose only skip test was
// `adults > 0 || children > 0`, wrote the CONFIRMED Family Memory fact
// "Household size: 1 adult", which nobody had said. The assistant then planned
// meals for a household of one.
//
// The draft now records whether the About step was answered (left with
// Continue) or skipped, finalize carries that, and the household's size is
// remembered only when it was answered.

/** The facts finalize would remember for a draft, through the same hops the action makes. */
function factsFor(draft: OnboardingDraft) {
  const payload = buildFinalizePayload(draft);
  const parsed = finalizeOnboardingSchema.parse(payload);
  const { details } = parsed;
  return onboardingFacts({
    householdAdults: details.householdAdults,
    householdChildren: details.householdChildren,
    householdAnswered: details.householdAnswered,
    childAges: details.childAges,
    region: details.region ?? null,
    country: details.country ?? null,
    goals: details.goals,
  });
}

const base = { name: 'Kim', familyName: 'The Kim Family' };

describe('a skipped About step remembers no household size', () => {
  it('the wizard as it really is when About was skipped: 1 adult seeded, nothing remembered', () => {
    const draft = emptyDraft(base);
    expect(draft.adults).toBe(1); // what the stepper shows before anyone touches it
    expect(factsFor(draft)).toEqual([]);
  });

  it('a stepper moved and the step then skipped is still not an answer', () => {
    const draft = emptyDraft({ ...base, adults: 2, children: 1, aboutAnswered: false });
    expect(factsFor(draft).map((f) => f.key)).not.toContain('Household size');
  });

  it('an answered About step is remembered, a single adult included', () => {
    expect(factsFor(emptyDraft({ ...base, aboutAnswered: true }))).toEqual([
      { category: 'about', key: 'Household size', content: '1 adult' },
    ]);
    expect(factsFor(emptyDraft({ ...base, aboutAnswered: true, adults: 2, children: 2, childAges: [6, 9] }))[0])
      .toEqual({ category: 'about', key: 'Household size', content: '2 adults and 2 children' });
  });

  it('onboardingFacts itself: an unanswered household is no fact, whatever the counts say', () => {
    const counts = { householdAdults: 1, householdChildren: 0, childAges: [], goals: [] };
    expect(onboardingFacts({ ...counts, householdAnswered: false })).toEqual([]);
    expect(onboardingFacts({ ...counts, householdAnswered: true })).toEqual([
      { category: 'about', key: 'Household size', content: '1 adult' },
    ]);
    // A caller that only ever sends answered counts (the complete-setup form) says nothing and is believed.
    expect(onboardingFacts(counts)).toEqual([{ category: 'about', key: 'Household size', content: '1 adult' }]);
  });

  it('what else the family typed on a skipped step is still theirs: goals are remembered', () => {
    const facts = factsFor(emptyDraft({ ...base, goals: ['meals'] }));
    expect(facts.map((f) => f.key)).toEqual(['What this family wants help with']);
  });
});

describe('the answer survives every hop between the wizard and the memory', () => {
  it('a new draft has not answered', () => {
    expect(emptyDraft().aboutAnswered).toBe(false);
  });

  it('the finalize payload says whether the household was answered', () => {
    expect(buildFinalizePayload(emptyDraft(base)).details.householdAnswered).toBe(false);
    expect(buildFinalizePayload(emptyDraft({ ...base, aboutAnswered: true })).details.householdAnswered).toBe(true);
  });

  it('the finalize schema keeps the flag instead of stripping it', () => {
    const parse = (draft: OnboardingDraft) => finalizeOnboardingSchema.parse(buildFinalizePayload(draft)).details.householdAnswered;
    expect(parse(emptyDraft(base))).toBe(false);
    expect(parse(emptyDraft({ ...base, aboutAnswered: true }))).toBe(true);
  });

  it('a reload mid-wizard keeps it, and a stored draft from before the flag has not answered', () => {
    const answered = parseDraftState(serializeDraftState('members', emptyDraft({ ...base, aboutAnswered: true }), true));
    expect(answered?.draft.aboutAnswered).toBe(true);
    const skipped = parseDraftState(serializeDraftState('members', emptyDraft(base), true));
    expect(skipped?.draft.aboutAnswered).toBe(false);

    const old = JSON.parse(serializeDraftState('members', emptyDraft(base), true)) as { draft: Record<string, unknown> };
    delete old.draft.aboutAnswered;
    expect(parseDraftState(JSON.stringify(old))?.draft.aboutAnswered).toBe(false);
    old.draft.aboutAnswered = 'yes';
    expect(parseDraftState(JSON.stringify(old))?.draft.aboutAnswered).toBe(false);
  });

  it('the wizard marks About answered on Continue and unanswered on Skip', () => {
    const wizard = readFileSync('components/onboarding/onboarding-wizard.tsx', 'utf8');
    const advance = bodyOf(wizard, '  function advance() {', '\n  }\n');
    expect(advance).toContain("if (step === 'about') update({ aboutAnswered: true });");
    expect(at(advance, "if (step === 'about') update({ aboutAnswered: true });")).toBeLessThan(at(advance, 'setStep(next);'));

    const skip = bodyOf(wizard, '// Skip bypasses the step\'s advance gate.', "{step === 'pin' ? tr('onboardingCopy.skipPin')");
    expect(skip).toContain("if (step === 'about') update({ aboutAnswered: false });");
    expect(at(skip, "if (step === 'about') update({ aboutAnswered: false });")).toBeLessThan(at(skip, 'setStep(next);'));
  });

  it('finalize hands the flag to the memory beside the counts', () => {
    const action = readFileSync('app/onboarding/actions.ts', 'utf8');
    const call = bodyOf(action, 'await rememberOnboardingFactsSafely(admin, {', '  // 7. Audit');
    expect(call).toContain('householdAdults: details.householdAdults,');
    expect(call).toContain('householdAnswered: details.householdAnswered,');
  });
});
