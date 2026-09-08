import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every public-site source that carries copy or sample data. Files that a
// later stage of the public-site plan creates are listed already and skipped
// while absent, so the guard picks them up the moment they land.
// app/(marketing)/security/page.tsx joined with the Trust Center stage, which
// is what removed the claims that page used to carry.
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
  'app/(marketing)/security/page.tsx',
  'app/(marketing)/ai/page.tsx',
  'app/(marketing)/mobile/page.tsx',
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

/**
 * The second corpus reads the catalogue by PREFIX rather than by reference:
 * every value under a public-site namespace, whether or not a listed file
 * renders it today. The key-following corpus above cannot see a claim parked
 * in a marketing key that nothing references yet — and the next page to
 * reference it would ship it. Scoped to the public-site namespaces for the
 * same reason `shipped` is scoped to the files.
 */
const MARKETING_KEY_PREFIXES = ['homeHero.', 'handledProof.', 'heroOutcomes.', 'firstBrief.', 'decisionsBand.', 'kitchenMode.', 'switching.', 'socialProof.', 'pricingValue.', 'trustCenter.', 'security.', 'featuresPage.', 'featureCards.', 'mobile.', 'root.meta', 'structuredData.'];
const marketingCopy = Object.entries(catalogue)
  .filter(([key]) => MARKETING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .map(([key, value]) => `${key}: ${value}`)
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
    for (const file of [
      'components/marketing/hero-outcomes.tsx',
      'components/marketing/handled-ledger.tsx',
      'lib/marketing/handled-sample.ts',
      'components/marketing/trust-ledger.tsx',
      'lib/marketing/trust-ledger.ts',
      'app/(marketing)/security/page.tsx',
    ]) {
      expect(present).toContain(file);
    }
  });

  it.each(FORBIDDEN)('does not ship unsupported claim %s in source', (claim) => {
    expect(sources).not.toMatch(claim);
  });

  it.each(FORBIDDEN)('does not ship unsupported claim %s in the copy those sources render', (claim) => {
    expect(shipped).not.toMatch(claim);
  });

  it.each(FORBIDDEN)('does not ship unsupported claim %s under a public-site catalogue prefix', (claim) => {
    expect(marketingCopy).not.toMatch(claim);
  });

  it('uses concrete security language', () => {
    expect(sources).toContain('Family-scoped access controls');
    expect(sources).toContain('Encrypted in transit and at rest');
  });
});
