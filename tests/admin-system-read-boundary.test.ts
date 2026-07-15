import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const system = readFileSync('app/(app)/admin/system/page.tsx', 'utf8');
const backup = readFileSync('app/(app)/admin/backup/page.tsx', 'utf8');

describe('admin operational read boundaries', () => {
  it('does not turn system usage query failures into zero-valued metrics', () => {
    expect(system).toContain('userCountResult.error');
    expect(system).toContain('documentsResult.error');
    expect(system).toContain('Could not load system usage from Supabase. Refresh and try again.');
  });

  it('does not turn data and storage query failures into zero-valued counts', () => {
    expect(backup).toContain('error } = await supabase.from');
    expect(backup).toContain('const readError = counts.find((c) => c.error)?.error ?? docsError');
    expect(backup).toContain('Could not load data and storage metrics from Supabase. Refresh and try again.');
  });
});
