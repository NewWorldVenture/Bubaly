import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const seed = readFileSync('supabase/SEED_ALL.sql', 'utf8');

describe('master seed scope boundary', () => {
  it('preflights the anchored account before any seed section can write', () => {
    const preflight = seed.indexOf('Master seed requires the anchored account');
    const firstSection = seed.indexOf('seed_core_content.sql');
    expect(preflight).toBeGreaterThan(0);
    expect(firstSection).toBeGreaterThan(preflight);
    expect(seed.slice(0, firstSection)).toContain('join auth.users u');
    expect(seed.slice(0, firstSection)).toContain('raise exception');
  });

  it('does not advertise an arbitrary-family fallback', () => {
    expect(seed.slice(0, 1800).toLowerCase()).not.toContain('falls back to the oldest family');
    expect(seed.slice(0, 1800).toLowerCase()).not.toContain('first family');
  });
});
