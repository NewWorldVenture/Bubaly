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

  it('keeps the marketplace hand-off seed fail-closed and conflict-safe', () => {
    const seed = readFileSync(resolve(supabaseDir, 'seed_marketplace_handoffs.sql'), 'utf8');
    const master = readFileSync(resolve(supabaseDir, 'SEED_ALL.sql'), 'utf8');
    const marker = 'seed_marketplace_handoffs.sql';
    const start = master.indexOf(marker);
    const end = master.indexOf('seed_marketplace_price_history.sql', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const masterSection = master.slice(start, end);
    for (const sql of [seed, masterSection]) {
      expect(sql).toMatch(/requires the anchored account/i);
      expect(sql).not.toMatch(/delete\s+from\s+public\.marketplace_(?:handoffs|orders|listings)/i);
      expect(sql).not.toContain('Pickup Pat');
      expect(sql).toContain("md5('familyos-seed-handoff-listing-' || i)::uuid");
      expect(sql).toContain('on conflict (order_id) do nothing');
    }
  });

  it('keeps the marketplace returns seed fail-closed and conflict-safe', () => {
    const seed = readFileSync(resolve(supabaseDir, 'seed_marketplace_returns.sql'), 'utf8');
    const master = readFileSync(resolve(supabaseDir, 'SEED_ALL.sql'), 'utf8');
    const marker = 'seed_marketplace_returns.sql';
    const start = master.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const nextSection = master.indexOf('\n-- ==================== ', start + marker.length);
    const masterSection = master.slice(start, nextSection > start ? nextSection : master.length);
    for (const sql of [seed, masterSection]) {
      expect(sql).toMatch(/requires the anchored account/i);
      expect(sql).toContain('returned_at is missing; apply migration 0192 first');
      expect(sql).not.toMatch(/delete\s+from\s+public\.marketplace_(?:orders|listings)/i);
      expect(sql).not.toContain('Pickup Pat');
      expect(sql).toContain("md5('familyos-seed-returns-listing-' || i)::uuid");
      expect(sql).toContain("md5('familyos-seed-returns-order-' || i)::uuid");
      expect(sql).toContain('on conflict (id) do nothing');
    }
  });
});
