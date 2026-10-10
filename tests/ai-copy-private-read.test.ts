import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aiCopyBaseline, verifyAiCopyPrivateRead } from '../scripts/verify-ai-copy-private-read.mjs';

describe('AI copy role fixture wiring', () => {
  it('extracts the complete real run-extension DO block and inherited policies', () => {
    const baseline = aiCopyBaseline();
    expect(baseline).toContain('add column if not exists request_id');
    expect(baseline).toContain('add column if not exists plan_id');
    expect(baseline).toContain('create policy ai_requests_insert');
    expect(baseline).toContain('create policy approval_requests_cancel_own');
    expect(baseline).toContain('create policy ai_run_events_select');
    expect(baseline).toMatch(/do \$\$[\s\S]+?add column if not exists idempotency_key text;\s*end \$\$;/);
  });

  it('rejects missing, relative or invalid connection identity before using PostgreSQL', () => {
    expect(() => verifyAiCopyPrivateRead({ postgresBin: undefined, port: undefined, expectedDataDir: undefined }))
      .toThrow('Explicit PostgreSQL');
    expect(() => verifyAiCopyPrivateRead({ postgresBin: 'relative', port: 55447, expectedDataDir: '/tmp/example' }))
      .toThrow('Explicit PostgreSQL');
    expect(() => verifyAiCopyPrivateRead({ postgresBin: '/tmp/bin', port: 0, expectedDataDir: '/tmp/example' }))
      .toThrow('Explicit PostgreSQL');
  });

  it('runs the actual role contract explicitly in hosted CI without an opt-in environment gate', () => {
    const workflow = readFileSync('.github/workflows/messaging-preserve-access.yml', 'utf8');
    expect(workflow).toContain('node scripts/verify-ai-copy-private-read.mjs');
    expect(workflow).toContain('--expected-data-dir /var/lib/postgresql/data/pgdata');
    expect(workflow).not.toContain('AI_COPY_PRIVACY_PG_BIN');
  });
});

// Hosted CI invokes the standalone runner directly. Local Vitest only opts in
// with an explicit disposable cluster identity; no credentials are discovered.
const postgresBin = process.env.AI_COPY_PRIVACY_PG_BIN;
const port = process.env.AI_COPY_PRIVACY_PG_PORT;
const expectedDataDir = process.env.AI_COPY_PRIVACY_PG_DATA_DIR;

describe.skipIf(!postgresBin || !port || !expectedDataDir)('AI copy PostgreSQL role contract', () => {
  it('protects raw copies, preserves reviewer/owner access and counts private sibling usage', () => {
    const result = verifyAiCopyPrivateRead({ postgresBin, port, expectedDataDir });
    expect(result.corrected).toBe('PASS, migration replayed twice, ROLLBACK');
    expect(result.assertionCount).toBeGreaterThan(80);
    expect(result.oldPolicy).toBe('expected private-request and inactive-owner assertion failures');
  }, 30_000);
});
