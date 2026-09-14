import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0298 is the real boundary: allowance_rules is manager-only in the database,
// proven behaviourally by docs/audit/allowance-rule-write-boundary-check.sql.
// This pins the SECOND lock on the same door.
//
// The allowance cron runs as the service role and bypasses RLS, so it is the
// one place where a row becomes money regardless of who wrote it. That matters
// twice: for rules written before 0298 reaches a database (F5 means migrations
// are not applied on merge here), and for any future policy drift — 0217
// narrowed five tables by name and left these six behind, which is exactly how
// this got here.
//
// Asserted against the ROUTE's own text because the alternative is a fake:
// mocking the service client proves the mock, and the behaviour that matters
// (RLS bypassed, real credit) needs the database the probe already uses.

const source = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');

describe('the allowance cron pays only rules a manager wrote', () => {
  it('reads the rule author', () => {
    const select = source.match(/\.from\('allowance_rules'\)\s*\n\s*\.select\('([^']+)'\)/);
    expect(select, 'the allowance_rules read was not found').not.toBeNull();
    expect(select?.[1]).toContain('created_by');
  });

  it('builds the manager set from active parents and adults of the due families', () => {
    const block = source.slice(source.indexOf('const authorKeys'), source.indexOf('let skippedUnauthored'));
    expect(block).toContain("from('family_members')");
    expect(block).toContain("in('role', ['parent', 'adult'])");
    expect(block).toContain("eq('is_active', true)");
    // Scoped to the families that actually have a due rule, not every family.
    expect(block).toContain("in('family_id', families)");
    // A read failure must not silently produce an EMPTY manager set, which
    // would skip every rule and look like a quiet no-op run.
    expect(block).toContain('if (managersError) throw managersError;');
  });

  it('skips a rule whose author is not an active manager, and counts it', () => {
    // Scoped to the guard itself. A previous test in this repo asserted a
    // string that turned out to live in a header comment; taking the condition
    // out of the loop body means the assertion cannot pass on prose.
    const start = source.indexOf('if (rule.created_by &&');
    expect(start, 'the author guard was not found').toBeGreaterThan(-1);
    const guard = source.slice(start, source.indexOf('\n      }', start) + 8);
    expect(guard).toContain('authorKeys.has(`${rule.family_id}:${rule.created_by}`)');
    expect(guard).toContain('skippedUnauthored++');
    expect(guard).toContain('continue;');
    // The guard sits INSIDE the loop that credits, ahead of the credit.
    expect(start).toBeGreaterThan(source.indexOf('for (const rule of rules'));
    expect(start).toBeLessThan(source.indexOf('creditChildWallet(supabase'));
  });

  it('reports the skip rather than swallowing it', () => {
    expect(source).toContain('skippedUnauthored });');
  });

  it('still pays a rule with no author — that is the seed and service-role path', () => {
    // `rule.created_by &&` is the whole of it: a null author is not a rule
    // somebody wrote, it is a rule that predates the column or came from the
    // trusted server. Refusing those would stop legitimate allowances.
    expect(source).toContain('if (rule.created_by && !authorKeys.has(');
  });
});
