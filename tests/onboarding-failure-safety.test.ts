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
});
