import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every public-site source that carries copy or sample data. Files that a
// later stage of the public-site plan creates are listed already and skipped
// while absent, so the guard picks them up the moment they land.
// app/(marketing)/security/page.tsx joins this list with the Trust Center
// stage, which is what removes the claims that page still carries today.
const FILES = [
  'components/marketing/visual-mocks.tsx',
  'components/marketing/reference-showcases.tsx',
  'components/marketing/hero-outcomes.tsx',
  'components/marketing/handled-ledger.tsx',
  'components/marketing/first-brief-band.tsx',
  'components/marketing/decisions-band.tsx',
  'components/marketing/kitchen-mode-band.tsx',
  'components/marketing/switching-band.tsx',
  'components/marketing/social-proof-band.tsx',
  'components/marketing/pricing-value-block.tsx',
  'components/marketing/trust-ledger.tsx',
  'lib/marketing/format.ts',
  'lib/marketing/handled-sample.ts',
  'lib/marketing/hero-outcomes.ts',
  'lib/marketing/trust-copy.ts',
  'lib/marketing/trust-ledger.ts',
  'app/(marketing)/page.tsx',
];

const catalogue = JSON.parse(
  readFileSync(resolve(process.cwd(), 'lib/i18n/messages/en-US.json'), 'utf8'),
) as Record<string, string>;

const present = FILES.filter((file) => existsSync(resolve(process.cwd(), file)));
const files = present.map((file) => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');

/**
 * The copy these files ship — which now lives in the catalogue, not in the
 * source. Following the keys matters in BOTH directions: the positive check
 * would simply fail, but every "does not ship this claim" assertion would have
 * gone quietly vacuous, still passing while "Bank-level security" sat in a
 * catalogue value one indirection away.
 *
 * Scoped to the keys these files actually reference rather than the whole
 * catalogue, so the guard keeps meaning "what the public marketing pages say"
 * — the admin competitive-intelligence screens legitimately name Forbes and
 * TechCrunch, and sweeping them in would fail this on unrelated copy.
 */
const shipped = [...files.matchAll(/'([a-zA-Z][\w]*\.[\w]+)'/g)]
  .map((m) => catalogue[m[1]])
  .filter((value): value is string => typeof value === 'string')
  .join('\n');

const sources = `${files}\n${shipped}`;

const FORBIDDEN = [
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
  /saved \d+ hours/i,
  /hours saved/i,
  /families saved/i,
  /SOC 2 Type II/,
  /HIPAA/,
  /Audited annually/,
  /99\.99%/,
  /\$\d+ (screen|display|frame)/,
  /zero setup/i,
];

describe('public marketing claims', () => {
  it('covers the sources this stage ships', () => {
    for (const file of ['components/marketing/hero-outcomes.tsx', 'components/marketing/handled-ledger.tsx', 'lib/marketing/handled-sample.ts']) {
      expect(present).toContain(file);
    }
  });

  it.each(FORBIDDEN)('does not ship unsupported claim %s in source', (claim) => {
    expect(sources).not.toMatch(claim);
  });

  it.each(FORBIDDEN)('does not ship unsupported claim %s in the marketing catalogue', (claim) => {
    expect(shipped).not.toMatch(claim);
  });

  it('uses concrete security language', () => {
    expect(sources).toContain('Family-scoped access controls');
    expect(sources).toContain('Encrypted in transit and at rest');
  });
});
