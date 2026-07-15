import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('lib/supabase/auth.ts', 'utf8');

describe('authenticated family context integrity', () => {
  it('does not treat a missing family row as onboarding', () => {
    expect(source).toContain('family context incomplete');
    expect(source).toContain('familyIds.some((familyId) => !byId.has(familyId))');
    expect(source).toContain("throw new Error('Account context is temporarily unavailable.')");
  });

  it('does not silently drop memberships when context rows do not join', () => {
    expect(source).toContain('family membership context incomplete');
    expect(source).toContain('memberships.length !== rows.length');
  });
});
