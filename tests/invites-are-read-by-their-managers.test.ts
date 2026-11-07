import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0533 (COVER-O1, with the per-role read matrix DB-TBL-194).
// invites_select let any member of a household read every invite in it, with
// the invitee's email, role, bearer token and expiry. 0533 is the register's
// owner action: a household's managers, and the person invited.

const M = 'supabase/reserved/0533_invites_are_read_by_their_managers.sql';
const P = 'docs/audit/reserved/invites-are-read-by-their-managers-check.sql';
const W = '.github/workflows/invite-reading-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('invites are read by their managers and the person invited (0533)', () => {
  const sql = read(M);

  it('is exactly the register\'s owner action, and only the read changes', () => {
    expect(sql).toContain('drop policy if exists invites_select on public.invites;\n'
      + 'create policy invites_select on public.invites for select\n'
      + "  using (public.can_manage_family(family_id) or lower(email) = lower(coalesce(auth.jwt()->>'email','')));");
    expect(sql.match(/create policy/g)).toHaveLength(1);
    expect(sql).not.toMatch(/(drop|create|alter) policy (if exists )?invites_(insert|update|delete)/);
    expect(sql).toContain("qual is distinct from '(can_manage_family(family_id) OR (lower(email) = lower(COALESCE((auth.jwt() ->> ''email''::text), ''''::text))))'");
  });

  it('every user-client reader of invites is a manager\'s', () => {
    const pending = read('components/family/pending-invites.tsx');
    expect(at(pending, 'if (!manages) return () => { live = false; };')).toBeLessThan(at(pending, "void settle(createClient().from('invites')"));
    const resend = bodyOf(read('app/api/email/invite/route.ts'), 'export async function POST(', ".from('invites')");
    expect(resend).toContain('if (!isManager(ctx.active.role)) return NextResponse.json(');
    const home = read('app/(app)/home/page.tsx');
    expect(at(home, 'if (manager) {')).toBeLessThan(at(home, "settle(supabase.from('invites').select('id', { count: 'exact', head: true }).eq('family_id', familyId)),"));
    // The join preview and acceptance read through the service client.
    expect(read('app/join/actions.ts')).toContain("await createServiceClient().from('invites')");
  });
});

describe('the probe and its workflow', () => {
  it('the probe records the per-role read matrix, with its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', ", "('guest', "]) expect(probe, role).toContain(role);
    expect(probe).toContain("('Olive read her own invite (the join preview)', 'authenticated', olive, 'c0533-olive@example.com', 'OK 1',");
    expect(probe).toContain("('Ned, invited nowhere, read no invite', 'authenticated', '00000000-0000-4000-8533-0000000000a9', 'c0533-ned@example.com', 'OK 0',");
    // Matched case-insensitively, as invites_select lowers both sides.
    expect(probe).toContain("'C0533-Teen@example.com'");
    expect(probe).toContain('-- N1. invites_select back to is_family_member.');
    expect(probe).toContain('-- M1. The invitee\'s arm dropped.');
  });

  it('the workflow shows the failure, applies 0533 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema lets a child read every invite and its token')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'invites-are-read-by-their-managers: OK'");
    for (const probe of ['invite-terms-boundary', 'invite-role-escalation', 'invite-cannot-rewrite-what-it-grants', 'rls-sweep']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
