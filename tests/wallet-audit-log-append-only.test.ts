import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 money-audit-trail integrity guard. wallet_audit_logs shipped (0088) with
// the systemic `"Members manage" ... FOR ALL is_family_member` policy and was NOT
// covered by the 0217 wallet ledger lockdown, so a child could `update`/`delete`
// money-audit rows directly via PostgREST — rewriting or erasing the history a
// parent relies on (no money moves; the ledger wallet_transactions is locked by
// 0217). Migration 0224 makes the log append-only for clients: members keep
// SELECT + INSERT (every existing append still works), but UPDATE/DELETE have no
// authenticated policy, so only the service role (BYPASSRLS) can alter/prune it.
// Proven live on the PG16 harness: child SELECT + INSERT allowed; child
// UPDATE/DELETE affect 0 rows (blocked); service-role UPDATE/DELETE allowed.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_wallet_audit_log_append_only.sql'));
  expect(files.length, 'wallet_audit_log_append_only migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0224 wallet_audit_logs append-only', () => {
  const sql = migration();

  it('drops the permissive FOR ALL "Members manage" policy from 0088', () => {
    expect(sql).toContain('drop policy if exists "Members manage wallet_audit_logs"');
  });

  it('keeps SELECT open to family members', () => {
    expect(sql).toContain('create policy wallet_audit_logs_select on public.wallet_audit_logs\n    for select to authenticated using (public.is_family_member(family_id))');
  });

  it('keeps INSERT (append) open to family members', () => {
    expect(sql).toContain('create policy wallet_audit_logs_insert on public.wallet_audit_logs\n    for insert to authenticated with check (public.is_family_member(family_id))');
  });

  it('grants NO UPDATE or DELETE policy to clients (append-only)', () => {
    expect(sql).not.toMatch(/for update to authenticated/);
    expect(sql).not.toMatch(/for delete to authenticated/);
  });

  it('is idempotent (guarded + drop-then-create)', () => {
    expect(sql).toContain("to_regclass('public.wallet_audit_logs') is null");
    expect(sql).toContain('drop policy if exists wallet_audit_logs_select');
    expect(sql).toContain('drop policy if exists wallet_audit_logs_insert');
  });
});
