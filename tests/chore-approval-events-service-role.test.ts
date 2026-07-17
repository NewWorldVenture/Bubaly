import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-07 audit-trail wiring guard. chore_approval_events is an append-only audit
// log that ships (0043) SELECT-only for family members — "written by the
// service-role engine" — with NO authenticated INSERT policy. logChoreEvent was
// called with the caller's session (a child on submit/dispute, a manager on
// approve/reject), so every non-auto-approve event was silently RLS-denied and
// the approval history never recorded. Proven live on the PG16 harness: an
// authenticated (child AND manager) INSERT into chore_approval_events →
// "new row violates row-level security policy"; a service-role INSERT passes RLS.
// The fix routes logChoreEvent through createServiceClient() internally.
const server = readFileSync('lib/chores/server.ts', 'utf8');
const missions = readFileSync('app/(app)/missions/actions.ts', 'utf8');

describe('chore_approval_events audit trail writes under the service role', () => {
  it('logChoreEvent derives a service client and no longer takes a session param', () => {
    const fn = server.slice(server.indexOf('export async function logChoreEvent'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // The insert must run under the service role, not a passed user session.
    expect(body).toContain('const supabase = createServiceClient();');
    expect(body).toContain("from('chore_approval_events').insert(");
    // The old signature took `supabase: DB` as the first arg — it must be gone.
    expect(server).not.toContain('export async function logChoreEvent(\n  supabase: DB,');
  });

  it('lib/chores/server imports the service client', () => {
    expect(server).toContain("import { createServiceClient } from '@/lib/supabase/server'");
  });

  it('every missions caller invokes logChoreEvent without a client argument', () => {
    const calls = missions.match(/logChoreEvent\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    // No caller may pass `supabase`/`service` as the first argument anymore.
    expect(missions).not.toMatch(/logChoreEvent\((supabase|service),/);
  });
});
