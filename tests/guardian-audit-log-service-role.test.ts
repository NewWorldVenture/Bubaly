import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-12 audit-trail wiring guard (sibling of the chore_approval_events fix,
// PLA-0616). guardian_audit_log ships SELECT-only for family members
// (service-role-write by design) with NO authenticated INSERT policy, but the
// Guardian settings actions ran the audit insert through the acting parent's
// createServer() RLS session — so every guardian audit event was silently
// RLS-denied (the write is best-effort) and the child-safety audit trail never
// recorded. Proven live on the PG16 harness: a manager (parent) authenticated
// INSERT into guardian_audit_log → "new row violates row-level security policy";
// a service-role INSERT passes. The fix routes all audit writes through a
// service-role client (withGuardianTables(createServiceClient())).
const source = readFileSync('app/(app)/guardian/actions.ts', 'utf8');

describe('guardian_audit_log audit trail writes under the service role', () => {
  it('has a logGuardianAudit helper that uses the service-role client', () => {
    expect(source).toContain('async function logGuardianAudit(');
    const fn = source.slice(source.indexOf('async function logGuardianAudit('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('withGuardianTables(createServiceClient())');
    expect(body).toContain("from('guardian_audit_log').insert(");
  });

  it('imports the service client', () => {
    expect(source).toContain("import { createServer, createServiceClient } from '@/lib/supabase/server'");
  });

  it('no longer writes guardian_audit_log through the user-session db handle', () => {
    // The old pattern cast the user-session client for the audit insert.
    expect(source).not.toContain("db.from('guardian_audit_log')");
    // Every audit write now goes through the helper (4 known call sites).
    const calls = source.match(/logGuardianAudit\(\{/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
