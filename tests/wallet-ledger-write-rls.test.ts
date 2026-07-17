import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 CRITICAL money-integrity guard. The wallet money tables shipped (0088)
// with `is_family_member` FOR ALL, so a child (real Supabase session) could
// INSERT a completed credit into wallet_transactions via PostgREST and MINT
// spendable money. Migration 0217 restricts INSERT/UPDATE/DELETE on the wallet
// ledger tables to can_manage_family() while keeping SELECT open; the chore
// auto-approve reward (the one legitimate child-session write) is routed through
// the service role. Proven live on the PG16 harness (child insert -> RLS error;
// child read ok; manager + service_role write ok). This test pins the fix.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_wallet_ledger_write_lockdown.sql'));
  expect(files.length, 'wallet_ledger_write_lockdown migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0217 wallet ledger write lockdown', () => {
  const sql = migration();

  it('drops the permissive "Members manage" FOR ALL policy from 0088', () => {
    expect(sql).toContain('drop policy if exists "Members manage %1$s"');
  });

  it('restricts writes to can_manage_family and keeps SELECT for members', () => {
    expect(sql).toContain('for insert to authenticated with check (public.can_manage_family(family_id))');
    expect(sql).toContain('for update to authenticated using (public.can_manage_family(family_id))');
    expect(sql).toContain('for delete to authenticated using (public.can_manage_family(family_id))');
    expect(sql).toContain('for select to authenticated using (public.is_family_member(family_id))');
  });

  it('covers wallet_transactions (the money-minting vector) and the wallet tables', () => {
    for (const t of ['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules']) {
      expect(sql).toContain(`'${t}'`);
    }
  });

  it('routes the chore auto-approve reward through the service role', () => {
    const missions = readFileSync('app/(app)/missions/actions.ts', 'utf8');
    // The auto-approve branch must finalize (credit the ledger) with the service role.
    const autoBranch = missions.slice(missions.indexOf('if (autoOk && verdict.status'));
    expect(autoBranch).toContain('finalizeApproval(createServiceClient()');
    // The manual approve stays on the manager session (no service client there).
    const manual = missions.slice(missions.indexOf('export async function approveSubmissionAction'));
    const manualScope = manual.slice(0, manual.indexOf('\nexport async function', 1));
    expect(manualScope).toContain('finalizeApproval(supabase');
  });
});
