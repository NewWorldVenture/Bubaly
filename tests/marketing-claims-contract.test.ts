import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'components/marketing/visual-mocks.tsx',
  'components/marketing/reference-showcases.tsx',
  'lib/marketing/format.ts',
];

const catalogue = JSON.parse(
  readFileSync(resolve(process.cwd(), 'lib/i18n/messages/en-US.json'), 'utf8'),
) as Record<string, string>;

const files = FILES.map((file) => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');

/**
 * The copy these files ship — which now lives in the catalogue, not in the
 * source. Following the keys matters in BOTH directions: the positive check
 * would simply fail, but every "does not ship this claim" assertion would have
 * gone quietly vacuous, still passing while "Bank-level security" sat in a
 * catalogue value one indirection away.
 *
 * Scoped to the keys these three files actually reference rather than the whole
 * catalogue, so the guard keeps meaning "what the public marketing pages say"
 * — the admin competitive-intelligence screens legitimately name Forbes and
 * TechCrunch, and sweeping them in would fail this on unrelated copy.
 */
const shipped = [...files.matchAll(/'([a-zA-Z][\w]*\.[\w]+)'/g)]
  .map((m) => catalogue[m[1]])
  .filter((value): value is string => typeof value === 'string')
  .join('\n');

const sources = `${files}\n${shipped}`;

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
