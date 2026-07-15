import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const source = fs.readFileSync('app/api/cron/provider-sync/route.ts', 'utf8');

describe('provider sync cron response contract', () => {
  it('returns non-success status when one or more accounts fail', () => {
    expect(source).toContain('const ok = failed === 0 && auditFailed === 0;');
    expect(source).toContain('{ status: ok ? 200 : 502 }');
    expect(source).toContain('{ ok, synced, skipped, failed, auditFailed, scanned: accounts?.length ?? 0, details }');
  });

  it('keeps the provider failure response sanitized', () => {
    expect(source).toContain("error: 'Provider synchronization failed.'");
    expect(source).not.toContain('error: e.message');
    expect(source).not.toContain('error: error.message');
  });
});
