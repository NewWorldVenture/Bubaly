import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  completeProfileOnboardingSchema,
  inviteMemberActionSchema,
  localMemberActionSchema,
  previewCalendarImportSchema,
} from '@/lib/validation';

describe('onboarding failure safety', () => {
  it('bounds and validates runtime action payloads', () => {
    expect(previewCalendarImportSchema.safeParse({ source: 'paste', icsText: 'x'.repeat(200_001) }).success).toBe(false);
    expect(previewCalendarImportSchema.safeParse({ source: 'demo' }).success).toBe(true);
    expect(completeProfileOnboardingSchema.safeParse({ firstName: 'Ada', age: '' }).success).toBe(true);
    expect(completeProfileOnboardingSchema.safeParse({ firstName: 'Ada', pin: '12' }).success).toBe(false);
    expect(localMemberActionSchema.safeParse({ familyId: 'not-a-uuid', displayName: 'Kid', role: 'child' }).success).toBe(false);
    expect(inviteMemberActionSchema.safeParse({ familyId: 'not-a-uuid', email: 'nope', role: 'adult' }).success).toBe(false);
  });

  it('fails closed on required finalize writes instead of logging and continuing', () => {
    const source = readFileSync('app/onboarding/actions.ts', 'utf8');

    expect(source).toContain('describeActionError');
    expect(source).toContain('if (subErr) return onboardingFailure');
    expect(source).toContain('if (activeErr) return onboardingFailure');
    expect(source).toContain('if (detailsErr) return onboardingFailure');
    expect(source).toContain('if (memberErr) return onboardingFailure');
    expect(source).toContain('if (evErr) return onboardingFailure');
    expect(source).toContain('if (prefErr) return onboardingFailure');
    expect(source).not.toMatch(/if \(subErr\) console\.error/);
    expect(source).not.toMatch(/if \(activeErr\) console\.error/);
    expect(source).not.toMatch(/if \(detailsErr\) console\.error/);
    expect(source).not.toMatch(/if \(memberErr\) console\.error/);
    expect(source).not.toMatch(/if \(evErr\) console\.error/);
    expect(source).not.toMatch(/if \(prefErr\) console\.error/);
    expect(source).not.toMatch(/return profileRes;/);
  });

  it('fails closed on onboarding reads and scopes member writes to the resolved family', () => {
    // These three properties used to be asserted against
    // completeProfileOnboardingAction, which had no caller anywhere in the app
    // and was removed. The properties themselves still matter — they are what
    // keeps a failed read from being mistaken for "this account has no family"
    // — so they are asserted here against finalizeOnboardingAction, the action
    // the wizard actually runs, rather than deleted along with their old home.
    const source = readFileSync('app/onboarding/actions.ts', 'utf8');
    expect(source).toContain('membershipLookupError');
    expect(source).toContain("onboardingFailure('membership lookup', membershipLookupError");
    expect(source).toContain('prefReadError');
    expect(source).toContain("onboardingFailure('onboarding preferences read', prefReadError");
    // The member write is scoped by the upsert's conflict target rather than a
    // pair of .eq() filters: (family_id, user_id) is the key, so it cannot
    // touch a row in another household even if familyId were wrong.
    expect(source).toContain("{ onConflict: 'family_id,user_id' }");
    expect(source).toMatch(/family_id: familyId,\n\s*user_id: auth\.user\.id,/);
  });

  it('does not acknowledge compatibility provisioning after subscription state failures', () => {
    const source = readFileSync('lib/server/ensure-family.ts', 'utf8');
    expect(source).toContain('subReadErr');
    expect(source).toContain('if (subReadErr)');
    expect(source).toContain('active family upsert failed');
    expect(source).toContain('return false;');
  });
});
