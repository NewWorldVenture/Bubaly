import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An allowance period is paid once, by whichever run gets there first.
//
// Two code paths advance `allowance_rules.next_run_on` and credit a child's
// wallet: the nightly cron (`app/api/cron/wallet-allowance/route.ts`) and the
// parent's "Run now" button (`runDueAllowancesAction`). The exclusivity comes
// from CLAIMING the schedule — an update predicated on `.lte('next_run_on',
// today)`, so when two runs overlap only one matches a row; the first flips
// next_run_on into the future and the loser matches none and must skip.
//
// This test used to read ONE hardcoded file. Its header already stated the
// property in general terms — "if two invocations overlap (Vercel cron re-fire /
// MANUAL TRIGGER / >maxDuration run), both must NOT credit the same period" — and
// "manual trigger" is the server action, which the test never opened. So the
// action shipped with a blind update by id: both runs got a row back and both
// credited. Raced on two connections against a replayed database, 2-second
// overlap, the credit gated on the update's own RETURNING exactly as the code
// gates it:
//
//   == CRON shape — UPDATE carries .lte('next_run_on', today) ==
//   ledger_rows=1  cents_credited=1000
//   == SERVER ACTION shape — UPDATE by id only ==
//   ledger_rows=2  cents_credited=2000
//
// So the guard now DISCOVERS every site that advances a schedule and requires the
// claim of each. A third implementation cannot ship without one.
const FILES = execSync("git ls-files 'app/**/*.ts' 'lib/**/*.ts'", { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

/**
 * Every place that ADVANCES an allowance schedule, with the statement that does
 * it. Deliberately keyed on `next_run_on: next` — the ROLLBACK sites write
 * `next_run_on: rule.next_run_on` to restore the prior value when crediting
 * fails, and those must NOT carry the predicate (the whole point is to put the
 * rule back in the past so the next run retries).
 */
function scheduleClaims(): { file: string; statement: string }[] {
  const found: { file: string; statement: string }[] = [];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    let at = source.indexOf('.update({ next_run_on: next');
    while (at !== -1) {
      // The statement runs to its terminating semicolon; 1,200 characters is far
      // more than any of these chains and keeps a missing `;` from swallowing
      // the rest of the file.
      const end = source.indexOf(';', at);
      found.push({ file, statement: source.slice(at, end === -1 ? at + 1200 : end) });
      at = source.indexOf('.update({ next_run_on: next', at + 1);
    }
  }
  return found;
}

const claims = scheduleClaims();

describe('every allowance schedule advance claims the rule atomically', () => {
  // The blind-guard check, first. A discovery that finds nothing would satisfy
  // every `for` loop below and report success.
  it('finds both known implementations', () => {
    const files = [...new Set(claims.map((c) => c.file))].sort();
    expect(files).toEqual([
      'app/(app)/wallet/actions.ts',
      'app/api/cron/wallet-allowance/route.ts',
    ]);
  });

  it.each(claims.map((c) => [c.file, c.statement] as const))(
    '%s predicates the claim on next_run_on <= today',
    (_file, statement) => {
      expect(statement).toContain(".lte('next_run_on', today)");
    },
  );

  // `single()` treats zero rows as an error, which is exactly the case a loser
  // produces — so the claim has to read the row with `maybeSingle()` and then
  // decide, rather than failing.
  it.each(claims.map((c) => [c.file, c.statement] as const))(
    '%s reads the claimed row with maybeSingle, not single',
    (_file, statement) => {
      expect(statement).toContain('.maybeSingle()');
      expect(statement).not.toMatch(/\.single\(\)/);
    },
  );

  // And a loser must SKIP, not fail: the period is already paid, which is not an
  // error to report to the parent.
  it.each([...new Set(claims.map((c) => c.file))])('%s treats an unclaimed rule as already paid', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/if\s*\(!\w+\)\s*continue;/);
  });

  it.each([...new Set(claims.map((c) => c.file))])('%s credits through the ledger helper', (file) => {
    expect(readFileSync(file, 'utf8')).toContain('creditChildWallet(');
  });

  // The rollback sites are the mirror image and must stay unpredicated: they put
  // the schedule BACK in the past so the next run retries without skipping pay.
  it('leaves the failure rollbacks unpredicated', () => {
    const rollbacks = FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const at = source.indexOf('.update({ next_run_on: rule.next_run_on');
      return at === -1 ? [] : [{ file, statement: source.slice(at, source.indexOf(';', at)) }];
    });
    expect(rollbacks.length).toBe(2);
    for (const rollback of rollbacks) {
      expect(rollback.statement, `${rollback.file} must not predicate the rollback`)
        .not.toContain(".lte('next_run_on'");
    }
  });
});
