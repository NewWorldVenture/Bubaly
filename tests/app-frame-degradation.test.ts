import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const frame = fs.readFileSync('components/app/app-frame.tsx', 'utf8');

// AppFrame wraps every authenticated page, so a rejected read here is not one
// broken page — it is the whole signed-in app returning an error boundary. The
// two non-Postgrest checks in it gate access, so HOW they fail matters more
// than that they fail.
describe('app frame degradation', () => {
  it('resolves its reads through settleAll so a transport failure cannot reject the frame', () => {
    expect(frame).toContain('settleAll');
    // The batch itself must not be a bare Promise.all over Supabase reads.
    expect(frame).not.toMatch(/await Promise\.all\(\[\s*\n\s*supabase/);
  });

  it('fails CLOSED on the super-admin check', () => {
    // An unreachable check must never read as an affirmative one.
    expect(frame).toMatch(/isSuperAdmin\(\)\.catch\(/);
    expect(frame).toMatch(/console\.warn\('\[app-frame\] super-admin check failed — denying'/);
    const branch = frame.slice(frame.indexOf('isSuperAdmin().catch('));
    expect(branch.slice(0, 260)).toContain('return false;');
  });

  it('falls back to the free tier, never to a paid one', () => {
    expect(frame).toMatch(/resolveFamilyPlanLevel\([^)]*\)\.catch\(/);
    const branch = frame.slice(frame.indexOf('resolveFamilyPlanLevel(supabase'));
    expect(branch.slice(0, 320)).toContain('return 0 as');
  });
});
