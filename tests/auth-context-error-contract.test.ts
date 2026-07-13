import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('authenticated context error boundary', () => {
  it('does not treat failed context reads as a missing family', () => {
    const source = readFileSync('lib/supabase/auth.ts', 'utf8');

    expect(source).toContain("function throwContextUnavailable(scope: string, error: unknown): never");
    expect(source).toContain("throw new Error('Account context is temporarily unavailable.')");
    expect(source).toContain('const { data: members, error: membersError }');
    expect(source).toContain("if (membersError) throwContextUnavailable('family membership', membersError);");
    expect(source).toContain('const { data: families, error: familiesError }');
    expect(source).toContain("if (familiesError) throwContextUnavailable('family', familiesError);");
    expect(source).toContain('const { data: prefs, error: prefsError }');
    expect(source).toContain("if (prefsError) throwContextUnavailable('user preference', prefsError);");
  });
});
