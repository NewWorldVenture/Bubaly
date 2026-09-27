import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/audit/run-probes.sh runs every probe, in glob order, against ONE shared
// database. Seven probes opened with
//
//   grant select, insert, update, delete on all tables in schema public to authenticated;
//
// and two of them said why: "The harness grants table privileges to
// `authenticated`; RLS is the real gate." That was true when it was written —
// pg-bootstrap.sh sets `alter default privileges in schema public grant all on
// tables`, so every table a migration creates already carries full DML — which
// made the line redundant.
//
// It stopped being redundant the moment a migration revoked DML on purpose.
// 0300 takes UPDATE on families.trial_ends_at away from the client because that
// column IS the paywall. `ai-surface-role-privacy-check.sql` sorts first in the
// glob, so it handed the grant straight back, and every probe after it — 20 of
// 21 — measured a schema no deploy will ever run. The new entitlement probe
// passed alone and failed inside the suite, which is the only reason anyone
// noticed.
//
// This is 0292's defect in the harness rather than in a migration: a lockdown
// verified at its own moment in the chain, undone by what came later.
const DIR = 'docs/audit';
const sql = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const code = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('an audit probe measures the schema instead of rewriting it', () => {
  it('finds probes at all (guards the guard)', () => {
    expect(sql.length).toBeGreaterThan(10);
  });

  it('no probe grants privileges across the whole schema', () => {
    for (const f of sql) {
      expect(
        code(f),
        `${f} re-grants every table to a client role, which silently undoes any DML a migration revoked — for itself and for every probe that runs after it`,
      ).not.toMatch(/grant\s[^;]*\son\s+all\s+tables\s+in\s+schema/i);
    }
  });

  it('no probe grants every function, sequence or routine in a schema either (MAIN-F-015)', () => {
    // rls-isolation-check.sql once ran `grant execute on all functions in schema
    // public to authenticated` and never took it back, which quietly undid the
    // revokes in 0204/0253/0292 for every probe after it.
    for (const f of sql) {
      expect(
        code(f),
        `${f} re-grants a whole schema's functions to a role, which undoes any revoke a migration made`,
      ).not.toMatch(/grant\s[^;]*\son\s+all\s+(functions|sequences|routines|procedures)\s+in\s+schema/i);
    }
  });

  it('a probe that installs an extension takes its functions back from the client roles', () => {
    // pg-bootstrap.sh's default privileges give anon and authenticated every
    // function created in public, so `create extension dblink` alone left the
    // password-less, SECURITY DEFINER dblink_connect_u callable by anon until the
    // next run's definer-function probe caught it.
    const installers = sql.filter((f) => /create\s+extension\b/i.test(code(f)));
    expect(installers).toContain('wallet-concurrency-check.sql');
    for (const f of installers) {
      const body = code(f);
      const ext = [...body.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)].map((m) => m[1]);
      for (const name of ext) {
        if (name === 'plpgsql_check') continue; // no SECURITY DEFINER functions; runs only where the package exists
        expect(body, `${f} installs ${name} without revoking its functions`).toMatch(
          new RegExp(String.raw`e\.extname\s*=\s*'${name}'[\s\S]*revoke all on function %s from public, anon, authenticated`),
        );
      }
    }
  });

  it('no probe hands a client role DML on an entitlement table', () => {
    // The narrower shape the sweeping one would otherwise be replaced by.
    for (const f of sql) {
      expect(
        code(f),
        `${f} grants a client role write access to the tables lib/server/entitlement.ts reads`,
      ).not.toMatch(
        /grant\s[^;]*(insert|update|delete)[^;]*\son\s+(public\.)?(subscriptions|billing_customers|families)\b[^;]*to[^;]*(anon|authenticated)/i,
      );
    }
  });

  it('keeps the proof that the entitlement lockdown is measured, not assumed', () => {
    expect(sql).toContain('entitlement-write-boundary-check.sql');
    const probe = readFileSync(join(DIR, 'entitlement-write-boundary-check.sql'), 'utf8');
    // Judged on rows changed as well as on the refusal: an UPDATE that RLS
    // filters to no visible row changes nothing and raises nothing, so an
    // exception handler alone reads a silent block as a breach.
    expect(probe).toContain('get diagnostics n = row_count');
    expect(probe).toMatch(/if not blocked and n > 0 then/);
    // And it checks the grants from the catalog, not from the statements above.
    expect(probe).toContain('information_schema.column_privileges');
  });
});
