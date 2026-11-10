import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 money-safety guard. The live proof runs docs/audit/wallet-overspend-check.sql
// against the PG16 harness: it funds a $10 spend bucket and asserts (via RAISE
// EXCEPTION) that wallet_reserve_card_auth cannot approve past the balance, counts
// a pending hold against the balance, and is idempotent per authorization id. This
// static test guards that probe (so it can't be deleted/gutted) and documents the
// invariant in CI alongside the pure-ledger conservation tests (wallet-ledger.test).
describe('A-08 wallet overspend probe is present and encodes its invariants', () => {
  const sql = readFileSync('docs/audit/wallet-overspend-check.sql', 'utf8');

  it('targets the atomic reserve RPC', () => {
    expect(sql).toContain('wallet_reserve_card_auth');
  });

  it('asserts overspend is prevented (a second hold past the balance is declined)', () => {
    expect(sql).toContain('overspend — second $8 approved with only $2 left');
    expect(sql).toContain('overspend — approved a hold against a $0 balance');
  });

  it('asserts idempotency per authorization id (no double hold on replay)', () => {
    expect(sql).toContain('idempotent replay of a hold was declined');
    expect(sql).toContain('expected 2 holds');
  });

  it('cleans up after itself (leaves no residue in the shared harness)', () => {
    expect(sql).toContain('delete from public.child_wallets where id = v_wallet');
    expect(sql).toContain('delete from public.family_members where id = v_member');
  });

  // The four cases above are satisfied by a COMMENT: `toContain` cannot tell
  // `if r then raise exception '…overspend…'` from the same line behind `--`.
  // Planting exactly that (both overspend raises, the replay raise, the hold
  // count and the final tidy-up commented out) left all four green. So the
  // cases below read the probe with its comment lines removed, and tie each
  // message to the call and the condition that raises it.
  const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const step = (amount: number, auth: string, condition: string, message: string) => new RegExp(
    `r := public\\.wallet_reserve_card_auth\\(v_family, v_wallet, ${amount}, '${auth}', '[^']*'\\);\\s*`
      + `if ${condition} then raise exception '${esc(message)}`,
  );

  it('raises, in executable SQL, when either hold past the balance is approved', () => {
    expect(code).toMatch(step(800, 'a8_auth_2', 'r', 'A-08 FAIL: overspend — second $8 approved with only $2 left'));
    expect(code).toMatch(step(100, 'a8_auth_4', 'r', 'A-08 FAIL: overspend — approved a hold against a $0 balance'));
  });

  it('raises, in executable SQL, when a replay is declined or places a second hold', () => {
    expect(code).toMatch(step(800, 'a8_auth_1', 'not r', 'A-08 FAIL: idempotent replay of a hold was declined'));
    expect(code).toMatch(/if holds <> 2 then raise exception 'A-08 FAIL: expected 2 holds/);
  });

  it('tidies up after its last assertion, in executable SQL', () => {
    const tail = code.slice(code.lastIndexOf('raise exception'));
    expect(tail).toContain('delete from public.wallet_transactions where child_wallet_id = v_wallet;');
    expect(tail).toContain('delete from public.wallet_buckets where child_wallet_id = v_wallet;');
    expect(tail).toContain('delete from public.child_wallets where id = v_wallet;');
    expect(tail).toContain('delete from public.family_members where id = v_member;');
  });

  // This file reads no database, so on its own it cannot see the reserve
  // function change. The probe can: it pins md5(pg_proc.prosrc) and raises when
  // the body it measured is not the pinned one. This case carries that pin
  // back to the tree — the body the LAST migration to define the function
  // installs must hash to the probe's pin — so loosening the balance guard, or
  // replacing the function in a later migration, fails here until the new body
  // has been read and the probe re-proven against it on the harness.
  it('pins the reserve function body the migrations install today', () => {
    const MIGRATIONS = 'supabase/migrations';
    const head = /create or replace function public\.wallet_reserve_card_auth\(/i;
    let live = { file: '', body: '' };
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
      const source = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
      const at = source.search(head);
      if (at < 0) continue;
      const quote = /\bas\s+(\$[a-z_]*\$)/i.exec(source.slice(at));
      if (!quote) continue;
      const open = at + quote.index + quote[0].length;
      const close = source.indexOf(quote[1], open);
      expect(close, `${file} never closes the body of wallet_reserve_card_auth`).toBeGreaterThan(open);
      live = { file, body: source.slice(open, close) };
    }
    expect(live.file, 'no migration defines public.wallet_reserve_card_auth').not.toBe('');

    const pin = /pinned_body_md5 constant text := '([0-9a-f]{32})';/.exec(code);
    expect(pin, 'the probe no longer pins the body it measures').not.toBeNull();
    expect(code).toMatch(/if md5\(body_at_start\) is distinct from pinned_body_md5 then\s*raise exception/);
    expect(
      createHash('md5').update(live.body).digest('hex'),
      `wallet_reserve_card_auth as ${live.file} installs it is not the body the probe was proven on`,
    ).toBe(pin![1]);

    // The guard itself, in that body: the bucket lock, holds counted, and the decline.
    expect(live.body).toMatch(/from public\.wallet_buckets\s+where [^;]*\bfor update;/);
    expect(live.body).toContain("status in ('completed', 'processing')");
    expect(live.body).toMatch(/if p_amount > v_spendable then\s*return false;/);
  });
});
