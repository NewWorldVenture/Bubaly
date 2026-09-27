// The trust ledger recorded every decision the permission system MADE, and
// nothing at all about who changed the permission system.
//
// `trust_audit_logs_decision_check` has named fifteen decision values since the
// table shipped. Ten are written somewhere in the tree. Five were written
// nowhere — and all five are changes to the RULES:
//
//   policy_changed · grant_changed · delegation_changed · role_changed · emergency_ended
//
// So a parent could write a policy that lets Bubaly spend money unattended,
// grant a capability, hand another member their authority, or end an emergency
// elevation that outranks every deny in the system, and the ledger that
// `app/(app)/dashboard/trust/page.tsx` renders and that
// `components/settings/privacy-center.tsx` presents to a family as "Who
// accessed what" had no row for any of it.
//
// A sixth defect sat in the same file: `activateEmergencyAction` was the ONLY
// one of the six `trust_audit_logs` writers that discarded its error. That
// matters more than it looks, because `serverWriter` falls back to the CALLER'S
// client when service credentials are missing and 0260 removed member INSERT on
// this table — so in that configuration the write fails, nothing says so, and a
// ledger that had stopped recording is indistinguishable from a family that had
// never declared an emergency.
//
// `role_changed` stays unwritten and is asserted as such below, because it
// cannot be written from where roles are changed: `family-module.tsx` edits
// `family_members` straight from the browser with no server action in the path,
// and the ledger is service-role-only. That is an architectural gap, not a
// missing line, and the audit records it rather than this test pretending
// otherwise. Audit C1-S8-04.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'someone@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY,
      role: state.role,
      member: { id: 'member-1', family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

const {
  savePolicyAction, togglePolicyAction, deletePolicyAction,
  setPermissionGrantAction, createDelegationAction, revokeDelegationAction,
  activateEmergencyAction, endEmergencyAction,
} = await import('@/app/(app)/dashboard/trust/actions');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>();
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('trust_policies', [{ id: 'policy-1', family_id: FAMILY, name: 'Ask first', enabled: true }]);
  db.seed('trust_delegations', [{ id: 'deleg-1', family_id: FAMILY, revoked_at: null }]);
  db.seed('emergency_sessions', [{ id: 'emg-1', family_id: FAMILY, ended_at: null }]);
  state.db = db;
  state.role = 'parent';
});

const ledger = () => db.table('trust_audit_logs') as Record<string, unknown>[];
const decisions = () => ledger().map((r) => r.decision);

const inFuture = () => new Date(Date.now() + 86_400_000).toISOString();

describe('changing the rules leaves a row in the ledger', () => {
  it('records a new policy, with the rule it actually wrote', async () => {
    expect(await savePolicyAction({
      name: 'Bubaly may book', domain: 'calendar', capability: 'automate',
      subjectKind: 'ai', effect: 'allow',
    })).toEqual({ ok: true });
    const row = ledger().find((r) => r.decision === 'policy_changed');
    expect(row, 'creating a policy wrote no ledger row').toBeTruthy();
    // Not just "something happened": the row has to carry what changed.
    expect(row!.family_id).toBe(FAMILY);
    expect(row!.actor_id).toBe('member-1');
    expect(row!.domain).toBe('calendar');
    expect(row!.capability).toBe('automate');
    expect(String(row!.reason)).toContain('Bubaly may book');
    expect((row!.context as Record<string, unknown>).effect).toBe('allow');
  });

  it('records enabling, disabling and deleting a policy', async () => {
    await togglePolicyAction({ id: 'policy-1', enabled: false });
    expect(String(ledger().at(-1)!.reason)).toContain('disabled');
    await deletePolicyAction({ id: 'policy-1' });
    expect((ledger().at(-1)!.context as Record<string, unknown>).deleted).toBe(true);
    expect(decisions()).toEqual(['policy_changed', 'policy_changed']);
  });

  it('records a permission grant and its removal', async () => {
    await setPermissionGrantAction({ memberId: 'member-2', domain: 'finances', capability: 'approve', effect: 'allow' });
    const granted = ledger().at(-1)!;
    expect(granted.decision).toBe('grant_changed');
    expect(granted.domain).toBe('finances');
    expect(String(granted.reason)).toContain('allow');

    await setPermissionGrantAction({ memberId: 'member-2', domain: 'finances', capability: 'approve', effect: 'clear' });
    const removed = ledger().at(-1)!;
    expect(String(removed.reason)).toContain('Cleared');
    // The ledger records how many grants the clear actually removed, so a real
    // clearance is distinguishable from a no-op afterwards (C1-S9-18).
    expect((removed.context as Record<string, unknown>).cleared).toBe(1);
  });

  it('does not record a clearance that did not happen (C1-S9-18)', async () => {
    // Clearing is idempotent — no grant means the end state the manager asked
    // for already holds — so this still succeeds. What it must NOT do is write
    // "Cleared the approve grant on finances" into the permission audit trail
    // when there was nothing to clear, which is what it said before, in exactly
    // the same words, either way.
    const before = ledger().length;
    expect(await setPermissionGrantAction({
      memberId: 'member-2', domain: 'medical', capability: 'approve', effect: 'clear',
    })).toEqual({ ok: true });
    expect(ledger().length, 'the attempt is still recorded').toBe(before + 1);
    const entry = ledger().at(-1)!;
    expect(String(entry.reason)).not.toContain('Cleared');
    expect(String(entry.reason)).toContain('to clear');
    expect((entry.context as Record<string, unknown>).cleared).toBe(0);
  });

  it('refuses to report a grant as saved when nothing was stored (C1-S9-18)', async () => {
    // The other half, and the one that is NOT idempotent: an upsert either
    // inserts or updates, so affecting no row means the allow/deny is not in
    // force. Telling a manager otherwise is the failure this surface exists to
    // prevent, so it is a hard failure like its five siblings in this file.
    const source = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');
    const grant = source.slice(source.indexOf('export async function setPermissionGrantAction'));
    const upsert = grant.slice(grant.indexOf(".from('permission_grants').upsert("));
    expect(upsert.slice(0, upsert.indexOf('recordTrustChange'))).toContain(".select('id')");
    expect(upsert.slice(0, upsert.indexOf('recordTrustChange'))).toContain('changedNothing(rows)');
  });

  it('records handing authority to someone else, and taking it back', async () => {
    expect(await createDelegationAction({
      fromMemberId: 'member-1', toMemberId: 'member-2',
      domains: ['calendar'], expiresAt: inFuture(),
    })).toEqual({ ok: true });
    const made = ledger().at(-1)!;
    expect(made.decision).toBe('delegation_changed');
    expect((made.context as Record<string, unknown>).toMemberId).toBe('member-2');

    await revokeDelegationAction({ id: 'deleg-1' });
    expect((ledger().at(-1)!.context as Record<string, unknown>).revoked).toBe(true);
  });

  it('records the END of an emergency, not only its start', async () => {
    await activateEmergencyAction({ kind: 'medical', elevatedDomains: ['medical'] });
    await endEmergencyAction({ id: 'emg-1' });
    // Both halves, in order. An override that outranks every deny with no sign
    // of stopping is the shape this closes.
    expect(decisions()).toEqual(['emergency_override', 'emergency_ended']);
  });

  it('records nothing when the action is refused', async () => {
    state.role = 'child';
    expect((await savePolicyAction({
      name: 'Let me', domain: 'calendar', capability: 'automate', subjectKind: 'ai', effect: 'allow',
    })).ok).toBe(false);
    await setPermissionGrantAction({ memberId: 'member-1', domain: 'finances', capability: 'approve', effect: 'allow' });
    await endEmergencyAction({ id: 'emg-1' });
    // A ledger that logged attempts as changes would be worse than one that
    // logged nothing — it would read as though the child had succeeded.
    expect(ledger()).toEqual([]);
  });
});

describe('no ledger write drops its error on the floor', () => {
  const WRITERS = [
    'app/(app)/dashboard/trust/actions.ts',
    'lib/trust/server.ts',
    'lib/trust/ledger.ts',
    'lib/services/approvals/index.ts',
    'lib/ai/tools/execute.ts',
    'app/api/privacy/export/route.ts',
  ];

  it('every trust_audit_logs insert captures its error', () => {
    const bare: string[] = [];
    for (const rel of WRITERS) {
      const src = readFileSync(rel, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!line.includes(".from('trust_audit_logs').insert(")) return;
        // The insert's own line must bind the result. `await x.from(...)` with
        // nothing on the left is the shape that shipped.
        if (!/(const|let)\s*\{[^}]*error/.test(line)) bare.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it('finds the writers it is about', () => {
    // Without this the test above passes on an empty list forever.
    const found = WRITERS.filter((rel) => readFileSync(rel, 'utf8').includes("from('trust_audit_logs').insert("));
    expect(found.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the five reserved rule-change decisions', () => {
  const sql = readFileSync('supabase/migrations/0251_ai_trust_hardening.sql', 'utf8');

  it('are all still named by the schema', () => {
    for (const d of ['policy_changed', 'grant_changed', 'delegation_changed', 'role_changed', 'emergency_ended']) {
      expect(sql, `the schema no longer reserves ${d}`).toContain(`'${d}'`);
    }
  });

  it('are written, except role_changed — which has nowhere to be written from', () => {
    const actions = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');
    for (const d of ['policy_changed', 'grant_changed', 'delegation_changed', 'emergency_ended']) {
      expect(actions, `nothing writes ${d}`).toContain(`'${d}'`);
    }
    // Roles are edited by a direct browser write with no server action, and the
    // ledger is service-role-only. If this ever becomes false, someone has
    // added the server path and role_changed should be written there.
    const familyModule = readFileSync('components/modules/family-module.tsx', 'utf8');
    expect(familyModule).toMatch(/from\('family_members'\)\s*\.\s*update\(payload\)/);
  });
});
