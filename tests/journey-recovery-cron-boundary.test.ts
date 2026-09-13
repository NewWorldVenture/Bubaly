import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/cron/journey-recovery/route.ts', 'utf8');

describe('journey recovery cron failure boundaries', () => {
  it('checks both abandonment sweep reads', () => {
    // Both sweeps read through `readAll`, so each answers `{ rows, error }`.
    // The boundary is that both bind the error and throw on it.
    expect(source.match(/const \{ rows: data, error \} = await readAll\(/g)).toHaveLength(2);
    expect(source).toContain(".from('onboarding_progress')");
    expect(source).toContain(".from('crm_contacts')");
    expect(source.match(/if \(error\) throw error;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('reports profile, automation, and sweep failures for retry', () => {
    expect(source).toContain('profileError');
    expect(source).toContain('let failed = 0;');
    expect(source).toContain('{ status: failed === 0 ? 200 : 502 }');
  });
});
