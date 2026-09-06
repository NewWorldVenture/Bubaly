import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The trust ledger is the family's evidence: "Bubaly asked, a parent said yes,
// here is why". 0093 let any active member INSERT into it and read all of it,
// so a child's session could author a record of an approval that never
// happened and read the reasoning behind every decision — reasoning that
// quotes balances, medical appointments and document names. 0260 makes the
// ledger server-written and manager-read, and gives emergency elevation the
// expiry 0093's own header promised.
const raw = readFileSync('supabase/migrations/0260_trust_ledger_lockdown.sql', 'utf8');
const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

describe('0260 trust ledger lockdown', () => {
  it('leaves no way for a session to author an audit record', () => {
    expect(sql).toContain('drop policy if exists trust_audit_insert on public.trust_audit_logs');
    // Dropped, not narrowed: a parent forging "the AI was allowed to do this"
    // is the same hole with a nicer role on it.
    expect(sql).not.toMatch(/create policy trust_audit_insert/);
  });

  it('keeps the ledger append-only', () => {
    expect(sql).not.toMatch(/create policy trust_audit_(update|delete)/);
  });

  it('shows the ledger to the people who set the rules, not to their children', () => {
    expect(sql).toMatch(/create policy trust_audit_read on public\.trust_audit_logs\s+for select to authenticated using \(public\.can_manage_family\(family_id\)\)/);
    expect(sql).not.toMatch(/create policy trust_audit_read[\s\S]*?is_family_member/);
  });

  it('gives every emergency elevation an end it does not have to be told', () => {
    expect(sql).toContain('add column if not exists expires_at timestamptz not null default (now() + interval \'4 hours\')');
    // An activation from last March must come back already expired, not be
    // handed four fresh hours by the migration that adds the column.
    expect(sql).toMatch(/update public\.emergency_sessions[\s\S]*?set expires_at = activated_at \+ interval '4 hours'[\s\S]*?where ended_at is null/);
  });

  it('indexes the question the trust loader actually asks', () => {
    expect(sql).toMatch(/create index if not exists idx_emergency_sessions_active\s+on public\.emergency_sessions\(family_id, expires_at\)\s+where ended_at is null/);
  });
});

describe('the code agrees with 0260', () => {
  it('loads only elevations that are open AND unexpired', () => {
    const server = readFileSync('lib/trust/server.ts', 'utf8');
    const load = server.slice(server.indexOf('loadTrustInputs'), server.indexOf('export async function evaluateTrust'));
    expect(load).toMatch(/from\('emergency_sessions'\)[\s\S]*?\.is\('ended_at', null\)\.gt\('expires_at', nowIso\)/);
  });

  it('writes every audit row through the ledger writer, never the caller’s client', () => {
    for (const path of ['lib/trust/server.ts', 'lib/services/approvals/index.ts', 'app/(app)/dashboard/trust/actions.ts']) {
      const src = readFileSync(path, 'utf8');
      const inserts = [...src.matchAll(/(.{0,60})\.from\('trust_audit_logs'\)\.insert\(/g)].map((m) => m[1]);
      expect(inserts.length, `${path} writes no audit row`).toBeGreaterThan(0);
      for (const prefix of inserts) {
        expect(prefix, `${path}: audit row written with a non-ledger client — ${prefix.trim()}`).toMatch(/writer|ledgerWriter/);
      }
    }
  });

  it('refuses an emergency that names nothing rather than elevating everything', () => {
    const actions = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const activate = actions.slice(actions.indexOf('activateEmergencyAction'), actions.indexOf('endEmergencyAction'));
    expect(activate).not.toContain("['all']");
    expect(activate).toMatch(/if \(!domains\.length\) return \{ ok: false/);
  });
});
