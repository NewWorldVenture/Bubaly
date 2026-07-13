import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = [
  'components/marketing/visual-mocks.tsx',
  'components/marketing/reference-showcases.tsx',
  'lib/marketing/format.ts',
].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');

describe('public marketing claims', () => {
  it.each([
    /Trusted by thousands/i,
    /Loved by Families/i,
    /families love Bubaly/i,
    /Jessica M\./,
    /David T\./,
    /Amanda R\./,
    /Forbes/,
    /TechCrunch/,
    /USA TODAY/,
    /Bank-level security/i,
    /End-to-end encrypted/i,
    /Your data is always protected/i,
  ])('does not ship unsupported claim %s', (claim) => {
    expect(sources).not.toMatch(claim);
  });

  it('uses concrete security language', () => {
    expect(sources).toContain('Family-scoped access controls');
    expect(sources).toContain('Encrypted in transit and at rest');
  });
});
