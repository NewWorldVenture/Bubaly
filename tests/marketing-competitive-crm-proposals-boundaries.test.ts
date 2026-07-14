import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sources = [
  'app/(app)/admin/marketing/competitive/actions.ts',
  'app/(app)/admin/marketing/crm/actions.ts',
  'app/(app)/admin/marketing/proposals/actions.ts',
];

describe('marketing competitive, CRM, and proposal action boundaries', () => {
  it('routes every mutation cluster through sanitized failure handling', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('marketingActionFailure');
      expect(source, path).toContain("import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure }");
      expect(source, path).not.toMatch(/const \{ data \} = await/);
    }
  });

  it('checks inserts before audit logging', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('const { data, error } = await');
      expect(source, path).toContain('if (error || !data) marketingActionFailure');
    }
  });

  it('checks update and delete target rows before revalidation', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain(".select('id').maybeSingle()");
      expect(source, path).toContain('not found');
    }
  });
});
