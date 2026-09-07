import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every public-site source that carries copy or sample data. Files that a
// later stage of the public-site plan creates are listed already and skipped
// while absent, so the guard picks them up the moment they land.
// app/(marketing)/security/page.tsx joined with the Trust Center stage, which
// is what removed the claims that page used to carry.
const SOURCE_FILES = [
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

const present = SOURCE_FILES.filter((file) => existsSync(resolve(process.cwd(), file)));
const sources = present.map((file) => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');

// The public copy itself lives in the catalogue; the marketing keys are
// checked with the same patterns so a claim cannot hide behind t().
const en = JSON.parse(readFileSync(resolve(process.cwd(), 'lib/i18n/messages/en-US.json'), 'utf8')) as Record<string, string>;
const MARKETING_KEY_PREFIXES = ['homeHero.', 'handledProof.', 'heroOutcomes.', 'firstBrief.', 'decisionsBand.', 'kitchenMode.', 'switching.', 'socialProof.', 'pricingValue.', 'trustCenter.', 'security.', 'featuresPage.', 'featureCards.', 'mobile.', 'root.meta', 'structuredData.'];
const marketingCopy = Object.entries(en)
  .filter(([key]) => MARKETING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .map(([key, value]) => `${key}: ${value}`)
  .join('\n');

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

  it.each(FORBIDDEN)('does not ship unsupported claim %s in the marketing catalogue', (claim) => {
    expect(marketingCopy).not.toMatch(claim);
  });

  it('uses concrete security language', () => {
    expect(sources).toContain('Family-scoped access controls');
    expect(sources).toContain('Encrypted in transit and at rest');
  });
});
