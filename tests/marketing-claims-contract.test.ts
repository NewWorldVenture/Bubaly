import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every public-site source that carries copy or sample data. Files that a
// later stage of the public-site plan creates are listed already and skipped
// while absent, so the guard picks them up the moment they land.
// app/(marketing)/security/page.tsx joins this list with the Trust Center
// stage, which is what removes the claims that page still carries today.
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
];

const present = SOURCE_FILES.filter((file) => existsSync(resolve(process.cwd(), file)));
const sources = present.map((file) => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');

// The public copy itself lives in the catalogue; the marketing keys are
// checked with the same patterns so a claim cannot hide behind t().
const en = JSON.parse(readFileSync(resolve(process.cwd(), 'lib/i18n/messages/en-US.json'), 'utf8')) as Record<string, string>;
const MARKETING_KEY_PREFIXES = ['homeHero.', 'handledProof.', 'heroOutcomes.', 'firstBrief.', 'decisionsBand.', 'kitchenMode.', 'switching.', 'socialProof.', 'pricingValue.', 'trustCenter.', 'root.meta', 'structuredData.'];
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
  // Pricing may name competitors, but never quote their prices, and never
  // price the family's time against a nanny or an assistant.
  /(Cozi|FamilyWall|OurHome|FamCal|Skylight)[^\n]{0,60}\$\d/,
  /\$\d[^\n]{0,60}(Cozi|FamilyWall|OurHome|FamCal|Skylight)/,
  /(nanny|babysitter|housekeeper|personal assistant)[^\n]{0,40}(\$|per hour|an hour)/i,
  /(\$|per hour|an hour)[^\n]{0,40}(nanny|babysitter|housekeeper)/i,
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
    expect(marketingCopy).not.toMatch(claim);
  });

  it('uses concrete security language', () => {
    expect(sources).toContain('Family-scoped access controls');
    expect(sources).toContain('Encrypted in transit and at rest');
  });

  // The /pricing value block is where three kinds of number sit closest
  // together, so it is where blending them would be easiest. These pin the
  // separation at source level; lib/marketing/value.ts holds the arithmetic
  // and tests/marketing-value.test.ts proves the rounding.
  describe('the pricing value block keeps its three sources apart', () => {
    const block = readFileSync(resolve(process.cwd(), 'components/marketing/pricing-value-block.tsx'), 'utf8');
    const pricing = readFileSync(resolve(process.cwd(), 'app/(marketing)/pricing/pricing-content.tsx'), 'utf8');

    it('omits the real card rather than printing a zero', () => {
      expect(block).toContain('realHandledCounts(handled)');
      expect(block).toContain('{real && (');
      // No fallback copy: when `real` is null the card is simply absent —
      // there is no ternary rendering a zero, a dash or a "coming soon".
      expect(block).not.toMatch(/real \?[^\n]*\bt\(/);
      expect(block).not.toMatch(/\?\?\s*['"]0['"]/);
    });

    it('badges the illustrative card and labels its estimate as one', () => {
      expect(block).toContain("t('handledProof.sampleBadge')");
      expect(block).toContain("t('pricingValue.estimateNote')");
      expect(en['pricingValue.estimateNote']).toMatch(/^Estimated\./);
      expect(en['pricingValue.estimateNote']).toMatch(/not a stopwatch/i);
    });

    it('says the family time-saved number is the family\'s own, not an average', () => {
      expect(en['pricingValue.yourNumbersBody']).toMatch(/estimates? the time handed back/i);
      expect(en['pricingValue.yourNumbersBody']).toMatch(/your (family|data)/i);
    });

    it('never claims Bubaly finished work that no row backs', () => {
      // The real card's only sentences are the two aggregate-count keys, both
      // read from public_handled_stats().
      expect(block).toContain("t('handledProof.aggregateNote', { count: real.total })");
      expect(block).toContain("t('handledProof.aggregate30d', { count: real.last30d })");
      expect(en['pricingValue.realFootnote']).toMatch(/finished state/i);
    });

    it('leaves no inert control on the page', () => {
      // Every button on /pricing changes the billing period; every other CTA
      // is a real link.
      const buttons = pricing.match(/<button\b/g) ?? [];
      const setPeriod = pricing.match(/setPeriod\('/g) ?? [];
      expect(buttons.length).toBe(setPeriod.length);
    });
  });
});
