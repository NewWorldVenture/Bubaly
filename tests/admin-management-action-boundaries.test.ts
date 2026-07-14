import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actions = readFileSync('app/(app)/admin/admins/actions.ts', 'utf8');
const client = readFileSync('components/admin/admin-row-actions.tsx', 'utf8');

describe('Admin Management action boundaries', () => {
  it('checks privileged access mutations and target rows', () => {
    expect(actions).toContain('describeActionError');
    expect(actions).toContain("if (!('supabase' in guarded)) return guarded;");
    expect(actions).toContain(".select('id').maybeSingle()");
    expect(actions).toContain('if (error) return actionFailure');
    expect(actions).toContain("if (!data) return { ok: false, error: 'Admin record not found.' }");
  });

  it('validates invitations and surfaces mutation failures in the client', () => {
    expect(actions).toContain('emailSchema.safeParse');
    expect(actions).toContain('requestedRole');
    expect(actions).toContain('return { ok: true };');
    expect(client).toContain('toastError');
    expect(client).toContain('success');
    expect(client).toContain('if (!result.ok)');
    expect(client).toContain('Please try again.');
  });
});
