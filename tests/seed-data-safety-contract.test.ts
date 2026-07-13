import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const supabaseDir = resolve(process.cwd(), 'supabase');

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '');
}

function seedFiles(): string[] {
  return readdirSync(supabaseDir)
    .filter((name) => name === 'SEED_ALL.sql' || /^seed.*\.sql$/i.test(name));
}

function networkAggregateSql(name: string): string {
  const sql = readFileSync(resolve(supabaseDir, name), 'utf8');
  if (name !== 'SEED_ALL.sql') return executableSql(sql);

  const start = sql.indexOf('seed_network_aggregates.sql');
  const end = sql.indexOf('seed_matrix_gaps.sql', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return executableSql(sql.slice(start, end));
}

describe('seed data safety', () => {
  it('never executes destructive schema or table-wide data statements', () => {
    const violations = seedFiles().flatMap((name) => {
      const sql = executableSql(readFileSync(resolve(supabaseDir, name), 'utf8'));
      const matches = [
        ...sql.matchAll(/\b(?:truncate(?:\s+table)?|drop\s+table)\b/gi),
        ...sql.matchAll(/\bdelete\s+from\s+(?:public\.)?[a-z_][a-z0-9_]*\s*;/gi),
      ];
      return matches.map((match) => `${name}: ${match[0].trim()}`);
    });

    expect(violations).toEqual([]);
  });

  it('upserts deterministic network fixtures without clearing shared aggregates', () => {
    for (const name of ['seed_network_aggregates.sql', 'SEED_ALL.sql']) {
      const sql = networkAggregateSql(name);
      expect(sql).not.toMatch(/delete\s+from\s+public\.network_aggregates/i);
      expect(sql).not.toMatch(/\brandom\s*\(/i);
      expect(sql).toContain('on conflict (scope, cohort_key, metric, value) do update');
      expect(sql).toContain('hashtextextended');
    }
  });
});
