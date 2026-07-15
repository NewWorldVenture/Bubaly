import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/cron/journey-recovery/route.ts', 'utf8');

describe('journey recovery cron failure boundaries', () => {
  it('checks both abandonment sweep reads', () => {
    expect(source).toContain('const { data, error } = await supabase');
    expect(source).toContain(".from('onboarding_progress')");
    expect(source).toContain(".from('crm_contacts')");
    expect(source).toContain('if (error) throw error;');
  });

  it('reports profile, automation, and sweep failures for retry', () => {
    expect(source).toContain('profileError');
    expect(source).toContain('let failed = 0;');
    expect(source).toContain('{ status: failed === 0 ? 200 : 502 }');
  });
});
