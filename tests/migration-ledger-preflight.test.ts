import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The ledger pre-flight is the artifact an operator reads BEFORE replaying
// migrations against production. Its whole value is that "present in schema"
// means the migration ran. A probe that cannot fail destroys that, silently,
// and looks identical to a working one in review.
//
// That is not hypothetical. The 0275 probe used to be:
//
//   not exists (... where c.relname = 'bills' and pol.polpermissive
//                 and ... not like '%can_manage_family%')
//
// an ABSENCE check — "bills has no ungated permissive write policy". A bills
// table with no policies at all satisfies it. So it reported "present in
// schema" whether or not 0275 had run.
//
// On 2026-09-11 a production pre-flight returned exactly that: 0275 "present",
// while 0254 read NOT present — on a database where wallet_transactions had no
// restrictive policy at all. Both migrations create those guards
// unconditionally, so both were in fact absent; only one probe could say so.
//
// Proven against real PostgreSQL 16.13 before this test was written, by running
// the actual migration files against a fixture of the ten money tables:
//   nothing applied -> 0249 / 0254 / 0275 all "NOT present"
//   real 0254 applied -> only 0254 flips to "present"   (it discriminates)
//   real 0275 applied -> 0275 flips too                 (3 guards per table)
//   bills policies then DELETED -> the OLD probe still said "present in schema"
const ROOT = join(__dirname, '..');
const PREFLIGHT = readFileSync(join(ROOT, 'docs/audit/migration-ledger-state.sql'), 'utf8');
const BOUNDARY = readFileSync(join(ROOT, 'docs/audit/money-boundary-state.sql'), 'utf8');

/** The `('0249', '...', <predicate>)` rows of the probe VALUES list. */
function probeBodies(): { version: string; body: string }[] {
  const block = PREFLIGHT.slice(PREFLIGHT.indexOf('), probe(version, what, present) as ('));
  return [...block.matchAll(/\('(\d{4})',\s*'[^']*',\s*([\s\S]*?)(?=\n    \('\d{4}'|\n\)\n)/g)].map(
    (m) => ({ version: m[1], body: m[2] }),
  );
}

/** A positive `exists (` — one that is not the tail of a `not exists (`. */
function hasPositiveExists(body: string): boolean {
  return [...body.matchAll(/exists\s*\(/g)].some(
    (m) => !/not\s+$/.test(body.slice(Math.max(0, m.index - 5), m.index)),
  );
}

describe('the ledger pre-flight cannot report a migration it did not observe', () => {
  it('probes all three hand-applied migrations', () => {
    expect(probeBodies().map((p) => p.version)).toEqual(['0249', '0254', '0275']);
  });

  // The rule the 0275 regression broke.
  it.each(['0249', '0254', '0275'])(
    'anchors the %s probe on something the migration CREATES, not on an absence',
    (version) => {
      const probe = probeBodies().find((p) => p.version === version);
      expect(probe, `no probe for ${version}`).toBeDefined();
      expect(
        hasPositiveExists(probe!.body),
        `${version}'s probe has no positive existence check, so it passes vacuously`,
      ).toBe(true);
    },
  );

  // Guard the specific dead form, by shape rather than by memory of it.
  it('never asks only whether a bad policy is absent', () => {
    for (const { version, body } of probeBodies()) {
      const positives = [...body.matchAll(/exists\s*\(/g)].filter(
        (m) => !/not\s+$/.test(body.slice(Math.max(0, m.index - 5), m.index)),
      );
      expect(positives.length, `${version} relies on absence alone`).toBeGreaterThan(0);
    }
  });

  // 0254 and 0275 create identically-named guards, so a probe that looks at one
  // table cannot say which migration it is seeing. 0254 covers the wallet group;
  // 0275 additionally gives the finance group the same guard, which is its
  // signature alone.
  it('tells 0254 and 0275 apart by the table group each one reaches', () => {
    const wallet = ['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules'];
    const finance = ['financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals'];
    for (const t of wallet) expect(PREFLIGHT).toContain(`('${t}')`);
    for (const t of finance) expect(PREFLIGHT).toContain(`('${t}')`);

    const p0254 = probeBodies().find((p) => p.version === '0254')!.body;
    const p0275 = probeBodies().find((p) => p.version === '0275')!.body;
    expect(p0254).toContain('wallet_tables');
    expect(p0254).not.toContain('finance_tables');
    expect(p0275).toContain('finance_tables');
  });

  // A table that does not exist must not be read as a missing guard, or the
  // pre-flight cries wolf on every environment that lacks the module.
  it('does not count an absent table as an unguarded one', () => {
    expect(PREFLIGHT).toContain("to_regclass('public.'||w.t) is not null");
    expect(PREFLIGHT).toContain("to_regclass('public.'||f.t) is not null");
  });

  it('stays read-only', () => {
    expect(PREFLIGHT).not.toMatch(/\b(insert into public|update public|delete from public|drop |alter table|create policy)\b/i);
  });
});

describe('the money boundary is reported as state, not as provenance', () => {
  it('verdicts every money table the runbook covers', () => {
    for (const t of ['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules',
                     'financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals']) {
      expect(BOUNDARY).toContain(`('${t}')`);
    }
  });

  // The distinction three reviews collapsed: a stray permissive write is
  // reportable, but only EXPLOITABLE when nothing restrictive ANDs it down.
  it('separates a stray that is guarded from one that is open', () => {
    expect(BOUNDARY).toContain('closed by restrictive guard');
    expect(BOUNDARY).toContain('*** OPEN - non-manager can write ***');
    expect(BOUNDARY).toContain('table absent');
  });

  // The blind spot this artifact exists to close, and the one it shares with
  // nothing else: with RLS off, every policy is inert. Such a table has no
  // ungated permissive write (it may have no policies at all) and therefore
  // reads as CLEAN under a policy-only rule — including under moneyWriteVerdict
  // in scripts/audit-production-migration-state.mjs, whose `unguarded` list only
  // contains tables that have at least one write policy.
  //
  // Proven against PostgreSQL 16.13: family_wallets with RLS disabled, three
  // restrictive guards still present and zero ungated writes, reported
  // "*** OPEN - RLS DISABLED ***" — where the policy-only rule said CLOSED.
  it('checks RLS is actually on before trusting any policy', () => {
    expect(BOUNDARY).toContain('relrowsecurity');
    expect(BOUNDARY).toContain('*** OPEN - RLS DISABLED ***');

    // And checks it FIRST: a later branch would be shadowed by the clean-looking
    // "no ungated write" case, which is exactly how this stays invisible.
    const verdict = BOUNDARY.slice(BOUNDARY.indexOf('case\n'), BOUNDARY.indexOf('end as verdict'));
    expect(verdict.indexOf('RLS DISABLED')).toBeLessThan(verdict.indexOf('manager-gated'));
    expect(verdict.indexOf('RLS DISABLED')).toBeLessThan(verdict.indexOf('non-manager can write'));
  });

  // A table with RLS on and no write policy denies writes; that is closed, and
  // must not be conflated with "policies exist and are gated".
  it('distinguishes deny-by-default from actively-gated', () => {
    expect(BOUNDARY).toContain('CLOSED - RLS on, no write policy grants access');
    expect(BOUNDARY).toContain('CLOSED - every write is manager-gated');
  });

  it('judges write commands only, leaving SELECT to the membership rule', () => {
    expect(BOUNDARY).toContain("polcmd in ('a','w','d','*')");
    expect(BOUNDARY).not.toContain("polcmd in ('r'");
  });

  it('names the offending policy rather than leaving it to be hunted', () => {
    expect(BOUNDARY).toContain('offending_policies');
    expect(BOUNDARY).toMatch(/string_agg\(polname/);
  });

  it('stays read-only', () => {
    expect(BOUNDARY).not.toMatch(/\b(insert into|update |delete from|drop |alter table|create policy)\b/i);
  });
});
