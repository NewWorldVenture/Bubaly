import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const rpc = readFileSync('supabase/migrations/0253_ai_worker_execute_lockdown.sql', 'utf8');
const wallet = readFileSync('supabase/migrations/0254_wallet_write_policy_drift.sql', 'utf8');
describe('production worker and wallet permission boundaries', () => {
  it('revokes direct client grants, not just PUBLIC, and keeps the service worker', () => {
    expect(rpc).toMatch(/revoke all on function public\.claim_ai_runs\(integer, integer\) from public, anon, authenticated/i);
    expect(rpc).toMatch(/grant execute on function public\.claim_ai_runs\(integer, integer\) to service_role/i);
    for (const role of ['anon', 'authenticated', 'service_role']) expect(rpc).toContain("has_function_privilege('" + role + "'");
  });
  it('protects all five money write surfaces with restrictive manager guards', () => {
    for (const table of ['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules']) expect(wallet).toContain("'" + table + "'");
    for (const command of ['insert', 'update', 'delete']) {
      expect(wallet).toContain('drop policy if exists %1$s_' + command);
      expect(wallet).toContain('as restrictive for ' + command + ' to authenticated');
      expect(wallet).toContain('%1$s_mng_' + command);
    }
    expect(wallet).toContain('public.can_manage_family(family_id)');
    expect(wallet).not.toMatch(/\b(?:insert into|update public\.|delete from|truncate|drop table)\b/i);
  });
});
