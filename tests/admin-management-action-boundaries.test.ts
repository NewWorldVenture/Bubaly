import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const actions = readFileSync('app/(app)/admin/admins/actions.ts', 'utf8');
const client = readFileSync('components/admin/admin-row-actions.tsx', 'utf8');

describe('Admin Management action boundaries', () => {
  it('checks privileged access mutations and target rows', () => {
    expect(actions).toContain('describeActionError(');
    expect(actions).toContain("if (!('supabase' in guarded)) return guarded;");
    expect(actions).toContain(".select('id').maybeSingle()");
    expect(actions).toContain('if (error) return actionFailure');
    expect(actions).toContain("if (!data) return { ok: false, error: t('actions.adminRecordNotFound') }");
  });

  it('validates invitations and surfaces mutation failures in the client', () => {
    expect(actions).toContain('emailSchema.safeParse');
    expect(actions).toContain('requestedRole');
    expect(actions).toContain('return { ok: true };');
    expect(client).toContain('toastError(');
    expect(client).toContain('success(');
    expect(client).toContain('if (!result.ok)');
    expectSays(client, 'adminRowActions.couldNotUpdateAdminAccess', "Could not update admin access. Please try again.");
  });

  it('validates the invited email inside inviteAdminAction itself, before it reads or writes a row', () => {
    // restoreSuperAdminGrant parses an email too, so the whole-file anchor above
    // holds without the invite's own check. Read the invite action's own body.
    const start = actions.indexOf('export async function inviteAdminAction(');
    expect(start).toBeGreaterThan(-1);
    const next = actions.indexOf('\nexport ', start + 1);
    const invite = actions.slice(start, next === -1 ? undefined : next);
    const parsed = invite.indexOf("emailSchema.safeParse(String(formData.get('email') ?? ''))");
    const refused = invite.indexOf("if (!parsedEmail.success) return { ok: false, error: t('actions.enterAValidEmailAddress') };");
    const firstQuery = invite.indexOf('.from(');
    expect(parsed).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(parsed);
    expect(firstQuery).toBeGreaterThan(refused);
    expect(invite).toContain('const email = parsedEmail.data;');
    expect(invite).toContain('requestedRole');
  });
});
