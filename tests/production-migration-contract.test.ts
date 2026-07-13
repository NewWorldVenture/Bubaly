import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const cases = [
  ['0174_workload_snapshots.sql', 'workload_snapshots'],
  ['0175_independence_milestones.sql', 'independence_milestones'],
  ['0176_marketplace_circles.sql', 'marketplace_circles'],
  ['0180_resend_webhook_dedup.sql', 'resend_webhook_events'],
  ['0181_guardian_callback_replay.sql', 'guardian_callback_events'],
] as const;

describe('forward-only production migration reconciliation', () => {
  it.each(cases)('%s creates and protects %s', (file, table) => {
    const sql = readFileSync(resolve(root, 'supabase', 'migrations', file), 'utf8');
    expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}`));
    expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`));
  });

  it.each([
    '0166_workload_snapshots.sql',
    '0167_independence_milestones.sql',
    '0173_marketplace_circles.sql',
  ])('removes the skipped historical version %s', (file) => {
    expect(existsSync(resolve(root, 'supabase', 'migrations', file))).toBe(false);
  });

  it('keeps the production audit aligned with the reconciled tables', () => {
    const audit = readFileSync(resolve(root, 'scripts', 'audit-supabase-schema.mjs'), 'utf8');
    for (const [file, table] of cases) {
      expect(audit).toContain(file);
      expect(audit).toContain(table);
    }
  });
});
