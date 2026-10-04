import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');
const supabaseDir = resolve(process.cwd(), 'supabase');

function stripSqlComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
}

describe('seed credential safety', () => {
  it('loads Supabase access only from the environment', () => {
    const scripts = readdirSync(scriptsDir)
      .filter((name) => /^seed.*\.mjs$/i.test(name) && name !== 'seed-client.mjs')
      .map((name) => ({ name, source: readFileSync(resolve(scriptsDir, name), 'utf8') }));

    expect(scripts.length).toBeGreaterThan(0);
    for (const { name, source } of scripts) {
      expect(source, name).toContain('createSeedClient()');
      expect(source, name).toContain('requireSeedScope()');
      expect(source, name).not.toMatch(/createClient\s*\(/);
      expect(source, name).not.toMatch(/https?:\/\/[^\s'"`]+\.supabase\.co/);
      expect(source, name).not.toMatch(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/);
      expect(source, name).not.toMatch(/a0cba6bd-88f7-48a9-926d-b27e5cf671dc/);
      expect(source, name).not.toMatch(/df41e924-9bea-4980-98d4-f9d78df05e49/);
    }
  });

  it('keeps the family-credentials SQL seed data-only and limited to the synthetic Patel fixture', () => {
    const seedPath = resolve(supabaseDir, 'seed_credentials_all_families.sql');
    const seed = readFileSync(seedPath, 'utf8');
    const executable = stripSqlComments(seed);
    const demoSeed = readFileSync(resolve(supabaseDir, 'seed.sql'), 'utf8');
    const fixtureId = '11111111-1111-1111-1111-111111111111';

    // This ID/name pair is the synthetic family explicitly declared by seed.sql.
    expect(demoSeed).toContain(`('${fixtureId}','The Patel Family','America/New_York')`);
    expect(seed).toContain(`fixture_family_id   constant uuid := '${fixtureId}'`);
    expect(seed).toContain("fixture_family_name constant text := 'The Patel Family'");
    expect(executable).toMatch(/where id = fixture_family_id\s+and name = fixture_family_name/i);
    expect(executable.match(/public\.families/gi)).toHaveLength(1);

    // A seed must never replace migrations 0296/0391's schema or RLS boundary.
    // Check the entire executable source, including the anonymous DO body, so
    // CREATE OR REPLACE, ALTER POLICY, and other DDL cannot hide in PL/pgSQL.
    expect(executable).not.toMatch(/\b(?:create|alter|drop|truncate|grant|revoke)\b/i);
    expect(executable).not.toMatch(/\b(?:enable|disable)\s+row\s+level\s+security\b/i);
    expect(executable).not.toMatch(/\bcreate\s+or\s+replace\b|\balter\s+policy\b/i);

    // Cleanup, insert, and the diagnostic read must all stay in the same fixture.
    expect(executable).toMatch(/delete\s+from\s+public\.family_credentials\s+where family_id = fixture_family_id\s+and\s*\(\s*coalesce\(notes, ''\) like '%\[seed:vault-fixture\]%'\s+or coalesce\(notes, ''\) like '%\[seed:vault\]%'\s*\)/i);
    expect(executable).toMatch(/insert\s+into\s+public\.family_credentials[\s\S]*?fixture_family_id/i);
    expect(executable).toMatch(/from\s+public\.family_credentials\s+where family_id = '11111111-1111-1111-1111-111111111111'::uuid[\s\S]*?\[seed:vault-fixture\]/i);
    expect(executable).not.toMatch(/family_id\s*=\s*f\.id/i);
    expect(executable).not.toMatch(/for\s+\w+\s+in\s+select[\s\S]*?public\.families/i);
  });
});
