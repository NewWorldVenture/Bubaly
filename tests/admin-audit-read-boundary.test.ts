import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const audit = readFileSync('app/(app)/admin/audit/page.tsx', 'utf8');
const auditLogs = readFileSync('app/(app)/admin/audit-logs/page.tsx', 'utf8');

describe('admin audit read boundaries', () => {
  it('surfaces log, family, and actor failures on the scoped audit view', () => {
    expect(audit).toContain('error: logsError');
    expect(audit).toContain('error: familiesError');
    expect(audit).toContain('error: actorsError');
    expect(audit).toContain('Could not load audit logs from Supabase. Refresh and try again.');
  });

  it('surfaces audit-log failures on the complete history view', () => {
    expect(auditLogs).toContain('error: logsError');
    expect(auditLogs).toContain('if (logsError)');
    expect(auditLogs).toContain('Could not load audit logs from Supabase. Refresh and try again.');
  });
});
