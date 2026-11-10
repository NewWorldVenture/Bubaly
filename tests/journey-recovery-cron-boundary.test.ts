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

  it('counts every failure path, so a failed run cannot answer 200', () => {
    // The 502 is only as good as the counter behind it: each path that
    // swallows a failure must add to `failed`.
    // A refused profile read is counted and the subject skipped.
    expect(source).toMatch(/if \(profileError\) \{\n[^\n]*\n\s*failed\+\+;\n\s*continue;\n\s*\}/);
    // A nudge that did not go out is counted, in both sweeps.
    expect(source.match(/if \(outcome\.failures > 0 \|\| outcome\.errors > 0\) \{\s*failed\+\+;/g)).toHaveLength(2);
    // A thrown fire and a thrown sweep are counted, in both sweeps.
    const catches = source.split('\n').filter((line) => line.includes('catch ('));
    expect(catches).toHaveLength(4);
    for (const line of catches) expect(line, line).toMatch(/catch \(e\) \{ failed\+\+;/);
    expect(source.match(/\bfailed\+\+/g)).toHaveLength(7);
    // Nothing resets or lowers the count before it decides the status.
    expect(source.match(/\bfailed\s*(?:=(?!=)|-=|--)/g)).toEqual(['failed =']);
  });
});
