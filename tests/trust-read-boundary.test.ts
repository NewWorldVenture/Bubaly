import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/trust/page.tsx', 'utf8');

// PLA-0779: Trust & Permissions is a security-state surface. If any of its six
// source-of-truth reads (members, policies, grants, delegations, approvals,
// active emergency sessions) fails, it must fail closed — never render them all
// as "none" (a child looks unrestricted, a pending approval vanishes, an active
// emergency-access session is hidden). The trust_audit_logs display stays
// best-effort; a genuinely missing table (unapplied migration) is tolerated.
describe('trust page read boundary', () => {
  it('collects the six security-state read errors with a missing-table filter', () => {
    expect(page).toContain('const trustError = [membersRes.error, policiesRes.error, grantsRes.error, delegationsRes.error, approvalsRes.error, emergenciesRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a trust read failure', () => {
    expect(page).toContain('if (trustError) {');
    expect(page).toContain("console.error('[dashboard/trust] trust read failed', trustError);");
    expect(page).toContain('return <ErrorState message="Could not load your family trust & permissions from Supabase. Refresh and try again." />;');
  });

  it('keeps the trust_audit_logs display best-effort (not in the fail-closed set)', () => {
    // The audit-log read stays destructured as { data: audit } — a log view,
    // deliberately excluded from the security-state fail-closed set.
    expect(page).toContain('{ data: audit },');
    expect(page).not.toContain('auditRes.error');
  });

  it('derives the security-state data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (trustError) {');
    const deriveIdx = page.indexOf('const members = membersRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
