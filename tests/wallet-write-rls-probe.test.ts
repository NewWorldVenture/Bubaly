import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 money-integrity guard. The live proof runs docs/audit/wallet-write-rls-check.sql
// against the PG16 harness: acting AS a child member of the anchor family, it asserts
// (via RAISE EXCEPTION) that a COMPLETE valid credit into wallet_transactions is
// RLS-rejected (0217 mint-lock, sqlstate 42501), the sibling wallet_* tables reject a
// child INSERT, wallet_audit_logs UPDATE/DELETE affect 0 rows while INSERT (append) is
// allowed (0224 append-only), and a manager write still succeeds (positive control).
// This static test guards that probe (so it can't be deleted/gutted) and backs the
// LB-010 exit criterion. Proven live on the harness: ALL INVARIANTS PASSED.
describe('A-08 wallet write-RLS probe is present and encodes its invariants', () => {
  const sql = readFileSync('docs/audit/wallet-write-rls-check.sql', 'utf8');

  it('proves the mint-lock with a complete, valid credit (only RLS can block it)', () => {
    expect(sql).toContain("'parent_top_up','completed','credit'");
    expect(sql).toContain('child MINTED a completed $9,999.99 credit into wallet_transactions');
  });

  it('covers the sibling money-ledger tables', () => {
    expect(sql).toContain("array['child_wallets','wallet_buckets','wallet_rules','family_wallets']");
  });

  it('asserts wallet_audit_logs is append-only (UPDATE/DELETE affect 0 rows, INSERT allowed)', () => {
    expect(sql).toContain('child UPDATEd % money-audit rows');
    expect(sql).toContain('child DELETEd % money-audit rows');
    expect(sql).toContain('child could not APPEND an audit row');
  });

  it('includes a manager positive control (the lockdown gates on role, not everyone)', () => {
    expect(sql).toContain('manager audit append was blocked (lockdown too strict)');
  });

  it('acts as an authenticated child via role + jwt claim (RLS is the gate)', () => {
    expect(sql).toContain("set_config('role','authenticated', true)");

    // This used to pin the child's uuid as a LITERAL, and that made the case
    // brittle about the wrong thing. The probe's ids had to change — it shared
    // `…0000000000c8` with child-login-mapping-is-managers-only-check.sql,
    // which commits its seed, so a SECOND run of the suite against one database
    // failed on a foreign key (see tests/boundary-probes-are-rerunnable.test.ts
    // for the whole shape). A rename that is correct should not fail a case
    // whose subject is "RLS is the gate, not the application".
    //
    // So assert the PROPERTY instead: the probe declares a child via `\set KID`,
    // seeds that id as a `child` family member, and hands the SAME id to
    // `request.jwt.claim.sub`. A probe that seeds one child and impersonates a
    // different uuid would prove nothing, and that is what this now catches.
    const kid = /^\\set KID '([0-9a-f-]{36})'/m.exec(sql);
    expect(kid, 'the probe no longer declares its child with \\set KID').not.toBeNull();
    expect(sql, 'the child id must be seeded as a `child` family member')
      .toContain(`:'KID', 'child'`);
    expect(sql, 'the session must be opened AS the child the probe seeded')
      .toContain(`set_config('request.jwt.claim.sub','${kid![1]}', true)`);

    // And EVERY identity it assumes must be one it seeded. `toContain` above is
    // satisfied by a single matching occurrence, and this probe opens a session
    // five times — so on its own it would pass a file that impersonates the
    // seeded child once and an unseeded uuid everywhere else. That is not a
    // hypothetical: planting exactly that left the case green, which is how
    // this second half came to exist.
    const declared = new Set(
      [...sql.matchAll(/^\\set [A-Z_]+ '([0-9a-f-]{36})'/gm)].map((m) => m[1]),
    );
    expect(declared.size, 'no \\set ids were parsed').toBeGreaterThan(1);
    const assumed = [...sql.matchAll(/request\.jwt\.claim\.sub'\s*,\s*'([0-9a-f-]{36})'/g)]
      .map((m) => m[1]);
    expect(assumed.length, 'the probe assumes no identity at all').toBeGreaterThan(1);
    expect(
      [...new Set(assumed)].filter((id) => !declared.has(id)),
      'the probe opens a session as a uuid it never declared with \\set, so nothing '
        + 'establishes that identity is a member of the family under test',
    ).toEqual([]);
  });

  // The cases above are `toContain` on the whole file, and a COMMENT satisfies
  // `toContain`. Commenting out every raise they name — the mint, the sibling
  // tables, UPDATE, DELETE, the append and the manager control — left all five
  // green over a probe that could no longer fail. So read the probe with its
  // comment lines removed, and tie each message to the statement it judges and
  // the condition that raises it.
  const uncommented = (text: string) => text.split('\n')
    .filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const code = uncommented(sql);

  it('raises, in executable SQL, when the child mint lands or is refused by anything but RLS', () => {
    expect(code).toMatch(new RegExp(
      'insert into public\\.wallet_transactions\\s*'
        + '\\(family_id, type, status, direction, amount_cents, currency, metadata\\)\\s*'
        + "values \\('[0-9a-f-]{36}','parent_top_up','completed','credit',[^;]*;\\s*"
        + 'exception when others then\\s*blocked := true; sqlst := sqlstate;[ \\t]*(?:--[^\\n]*)?\\s*end;\\s*'
        + 'if not blocked then\\s*'
        + "raise exception 'A-08 FAIL: child MINTED a completed \\$9,999\\.99 credit into wallet_transactions';",
    ));
    expect(code).toMatch(/if sqlst is distinct from '42501' then\s*raise exception 'A-08 FAIL: the child mint was refused with sqlstate %/);
  });

  it('raises, in executable SQL, for each sibling money-ledger table a child can insert into', () => {
    expect(code).toMatch(new RegExp(
      "ledger text\\[\\] := array\\['child_wallets','wallet_buckets','wallet_rules','family_wallets'\\];[^$]*?"
        + 'foreach t in array ledger loop[^$]*?'
        + "execute format\\(\\s*'insert into public\\.%I \\(family_id\\) values \\(%L\\)', t, '[0-9a-f-]{36}'\\);\\s*"
        + 'exception when others then blocked := true;[ \\t]*(?:--[^\\n]*)?\\s*end;\\s*'
        + "if not blocked then\\s*raise exception 'A-08 FAIL: child INSERT into % was NOT blocked",
    ));
  });

  it('raises, in executable SQL, on a tampered audit row, a refused append and a refused manager', () => {
    expect(code).toMatch(new RegExp(
      'update public\\.wallet_audit_logs set [^;]*;\\s*get diagnostics affected = row_count;\\s*'
        + "if affected <> 0 then raise exception 'A-08 FAIL: child UPDATEd % money-audit rows'",
    ));
    expect(code).toMatch(new RegExp(
      'delete from public\\.wallet_audit_logs\\s+where [^;]*;\\s*get diagnostics affected = row_count;\\s*'
        + "if affected <> 0 then raise exception 'A-08 FAIL: child DELETEd % money-audit rows'",
    ));
    expect(code).toMatch(/if not ok then raise exception 'A-08 FAIL: child could not APPEND an audit row/);
    expect(code).toMatch(/if not ok then raise exception 'A-08 FAIL: manager audit append was blocked \(lockdown too strict\)'/);
  });

  // This file reads no database, so the lockdown itself is proven only where
  // the probe runs. What CAN be read here is whether the rules the probe says
  // it rests on are still the ones the migrations install: its header names
  // 0275 as the last migration to create the wallet mint-lock pair, and the
  // absence of any UPDATE/DELETE policy on wallet_audit_logs (0224) as what
  // makes the trail append-only. Both are checked against the tree, found by
  // scanning every migration rather than by trusting those numbers.
  it('rests on a mint-lock and an append-only trail the migrations still install', () => {
    const MIGRATIONS = 'supabase/migrations';
    const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()
      .map((file) => ({ file, code: uncommented(readFileSync(`${MIGRATIONS}/${file}`, 'utf8')) }));

    // Mint-lock: the wallet policies are created in a loop over an array of
    // table names, so the live rule is in the last migration that both lists
    // 'wallet_transactions' in such an array and creates policies.
    const lockers = migrations.filter(({ code: m }) => /create policy/i.test(m)
      && [...m.matchAll(/array\s*\[[^\]]*\]/gi)].some((list) => list[0].includes("'wallet_transactions'")));
    expect(lockers.length, 'no migration creates policies over the wallet tables').toBeGreaterThan(0);
    const lock = lockers[lockers.length - 1];
    const tables = [...lock.code.matchAll(/array\s*\[[^\]]*\]/gi)]
      .map((list) => list[0]).find((list) => list.includes("'wallet_transactions'")) ?? '';
    for (const table of ['child_wallets', 'wallet_buckets', 'wallet_rules', 'family_wallets']) {
      expect(tables, `${lock.file} no longer locks ${table} with wallet_transactions`).toContain(`'${table}'`);
    }
    expect(lock.code, `${lock.file} no longer makes the permissive wallet INSERT manager-only`).toContain(
      'create policy %1$s_mng_insert on public.%1$I for insert to authenticated '
        + 'with check (public.can_manage_family(family_id))',
    );
    expect(lock.code, `${lock.file} no longer keeps the restrictive wallet INSERT guard manager-only`).toContain(
      'create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated '
        + 'with check (public.can_manage_family(family_id))',
    );

    // Append-only: from the migration that dropped the blanket policy onward,
    // every policy created on wallet_audit_logs is a SELECT or an INSERT.
    const from = migrations.findIndex(({ code: m }) => m.includes(
      'drop policy if exists "Members manage wallet_audit_logs" on public.wallet_audit_logs',
    ));
    expect(from, 'no migration drops the blanket wallet_audit_logs policy').toBeGreaterThanOrEqual(0);
    const created = migrations.slice(from).flatMap(({ file, code: m }) => [
      ...m.matchAll(/create policy\s+("[^"]+"|\S+)\s+on public\.wallet_audit_logs\b([^;]*);/gi),
    ].map((policy) => ({ file, name: policy[1], rest: policy[2].replace(/\s+/g, ' ').trim() })));
    expect(created.length, 'no wallet_audit_logs policy was found at all').toBeGreaterThan(1);
    expect(
      created.filter(({ rest }) => !/^for (select|insert) to authenticated\b/i.test(rest))
        .map(({ file, name, rest }) => `${file}: ${name} ${rest}`),
      'a policy on wallet_audit_logs that is not a SELECT or an INSERT ends the append-only trail',
    ).toEqual([]);
    const inserts = created.filter(({ rest }) => /^for insert\b/i.test(rest));
    expect(inserts.length, 'no INSERT policy on wallet_audit_logs: the append the probe allows has no rule').toBeGreaterThan(0);
    expect(inserts[inserts.length - 1].rest).toContain('public.is_family_member(family_id)');
  });
});
