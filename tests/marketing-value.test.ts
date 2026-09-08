import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASIC_ANNUAL_CENTS, BASIC_MONTHLY_CENTS, PLUS_ANNUAL_CENTS, PLUS_MONTHLY_CENTS,
} from '@/lib/constants/plans';
import { HANDLED_PUBLIC_MIN } from '@/lib/marketing/format';
import {
  VALUE_ROWS,
  VALUE_TIERS,
  formatPerDay,
  perDayCents,
  realHandledCounts,
  shouldShowRealHandled,
  valueTier,
  valueTierForLevel,
} from '@/lib/marketing/value';

// The pricing page's value arithmetic lives in lib/marketing/value.ts and
// nowhere else. Every expectation about rounding derives from
// lib/constants/plans.ts rather than from a typed dollar amount, so a price
// change moves the per-day line with it and this file keeps proving the rule.
const pricing = readFileSync('app/(marketing)/pricing/pricing-content.tsx', 'utf8');
const page = readFileSync('app/(marketing)/pricing/page.tsx', 'utf8');
const block = readFileSync('components/marketing/pricing-value-block.tsx', 'utf8');
const upgrade = readFileSync('components/app/upgrade-modal.tsx', 'utf8');
const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

describe('per-day framing never understates', () => {
  it('rounds UP: yearly over 365 days, monthly over 30', () => {
    expect(perDayCents(PLUS_ANNUAL_CENTS, 'yearly')).toBe(Math.ceil(PLUS_ANNUAL_CENTS / 365));
    expect(perDayCents(BASIC_ANNUAL_CENTS, 'yearly')).toBe(Math.ceil(BASIC_ANNUAL_CENTS / 365));
    expect(perDayCents(PLUS_MONTHLY_CENTS, 'monthly')).toBe(Math.ceil(PLUS_MONTHLY_CENTS / 30));
    expect(perDayCents(BASIC_MONTHLY_CENTS, 'monthly')).toBe(Math.ceil(BASIC_MONTHLY_CENTS / 30));
  });

  it('matches the figures the plan constants imply today', () => {
    expect(perDayCents(BASIC_ANNUAL_CENTS, 'yearly')).toBe(28);
    expect(perDayCents(PLUS_ANNUAL_CENTS, 'yearly')).toBe(69);
    expect(perDayCents(BASIC_MONTHLY_CENTS, 'monthly')).toBe(34);
    expect(perDayCents(PLUS_MONTHLY_CENTS, 'monthly')).toBe(84);
  });

  it('is never below the exact division, and degrades to nothing on bad input', () => {
    for (const [cents, period] of [
      [BASIC_ANNUAL_CENTS, 'yearly'], [PLUS_ANNUAL_CENTS, 'yearly'],
      [BASIC_MONTHLY_CENTS, 'monthly'], [PLUS_MONTHLY_CENTS, 'monthly'],
    ] as const) {
      expect(perDayCents(cents, period)).toBeGreaterThanOrEqual(cents / (period === 'yearly' ? 365 : 30));
    }
    expect(perDayCents(0, 'monthly')).toBe(0);
    expect(perDayCents(-100, 'yearly')).toBe(0);
    expect(perDayCents(Number.NaN, 'yearly')).toBe(0);
  });

  it('formats cents under a dollar and dollars from a dollar up', () => {
    expect(formatPerDay(perDayCents(BASIC_ANNUAL_CENTS, 'yearly'))).toBe('28¢');
    expect(formatPerDay(perDayCents(PLUS_MONTHLY_CENTS, 'monthly'))).toBe('84¢');
    expect(formatPerDay(100)).toBe('$1');
    expect(formatPerDay(105)).toBe('$1.05');
  });
});

describe('the REAL card hides below the public threshold', () => {
  it('shouldShowRealHandled flips exactly at HANDLED_PUBLIC_MIN', () => {
    expect(shouldShowRealHandled({ handledCompleted: HANDLED_PUBLIC_MIN - 1 })).toBe(false);
    expect(shouldShowRealHandled({ handledCompleted: HANDLED_PUBLIC_MIN })).toBe(true);
    expect(shouldShowRealHandled({ handledCompleted: 0 })).toBe(false);
    expect(shouldShowRealHandled(null)).toBe(false);
    expect(shouldShowRealHandled(undefined)).toBe(false);
  });

  it('never renders a zero: the counts are null when the card is hidden', () => {
    expect(realHandledCounts({ handledCompleted: 0, handled30d: 0 })).toBeNull();
    expect(realHandledCounts({ handledCompleted: HANDLED_PUBLIC_MIN - 1, handled30d: 5 })).toBeNull();
    // A read that failed closed reports zeros (lib/marketing/stats.ts); those
    // must hide the card rather than print "0 things finished".
    expect(realHandledCounts({ handledCompleted: Number.NaN, handled30d: Number.NaN })).toBeNull();
  });

  it('holds the 30-day figure to the same floor on its own', () => {
    expect(realHandledCounts({ handledCompleted: 25, handled30d: 3 })).toEqual({ total: '25', last30d: null });
    expect(realHandledCounts({ handledCompleted: 12345, handled30d: 25 })).toEqual({ total: '12,000+', last30d: '25' });
  });
});

describe('the value block renders three sources, never blended', () => {
  it('gates the REAL card behind realHandledCounts', () => {
    expect(block).toContain('realHandledCounts(handled)');
    expect(block).toContain('{real && (');
    expect(block).toContain("t('pricingValue.realTitle')");
  });

  it('badges the illustrative card and carries the estimate note', () => {
    expect(block).toContain('handledProof.sampleBadge');
    expect(block).toContain("t('pricingValue.estimateNote')");
    expect(block).toContain("t('pricingValue.minutesHandedBack', { minutes: sample.minutes })");
  });

  it('publishes no cross-family time-saved aggregate', () => {
    // Minutes are rendered exactly once, inside the badged sample card. The
    // REAL card holds counts only, until task #41 defines the north-star
    // metric that a published time-saved aggregate would need.
    const realCard = block.slice(block.indexOf('{real && ('), block.indexOf('</article>', block.indexOf('{real && (')));
    expect(realCard).not.toMatch(/minutes/i);
    expect(block.match(/t\('pricingValue\.minutesHandedBack'/g) ?? []).toHaveLength(1);
    expect(block).not.toContain('timeSaved');
  });

  it('stacks the matrix on phones instead of scrolling a table sideways', () => {
    expect(block).toContain('md:grid-cols-3');
    expect(block).not.toContain('<table');
    expect(block).not.toContain('overflow-x-auto');
    expect(block).not.toContain('min-w-[');
  });

  it('stays client-safe: no server-only imports reach it', () => {
    expect(block.startsWith("'use client'")).toBe(true);
    expect(block).not.toMatch(/from ['"]@\/lib\/i18n\/server['"]/);
    expect(block).not.toMatch(/from ['"]@\/lib\/marketing\/(stats|reputation-server)['"]/);
  });
});

describe('the tier registry is one source for both surfaces', () => {
  it('carries three tiers and three rows, each an English label plus a key', () => {
    expect(VALUE_TIERS.map((tier) => tier.key)).toEqual(['trial', 'basic', 'plus']);
    expect(VALUE_ROWS.map((row) => row.key)).toEqual(['youDecide', 'prepares', 'handles']);
    for (const row of VALUE_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(en[row.labelKey]).toBeTypeOf('string');
    }
  });

  it('resolves every catalogue key it names', () => {
    for (const tier of VALUE_TIERS) {
      for (const key of [tier.labelKey, tier.goalKey, tier.positioningKey, ...Object.values(tier.cells)]) {
        expect(en[key], key).toBeTypeOf('string');
      }
      expect(tier.outcomes.length).toBeGreaterThan(0);
      for (const outcome of tier.outcomes) {
        expect(en[outcome.labelKey], outcome.labelKey).toBeTypeOf('string');
        expect(outcome.label.length).toBeGreaterThan(0);
      }
    }
    expect(en['planOutcomes.heading']).toBeTypeOf('string');
  });

  it("names Family+'s handled routines as ones a family approves once", () => {
    expect(en[valueTier('plus').cells.handles]).toMatch(/approve once/i);
    expect(en[valueTier('plus').cells.handles]).toMatch(/meals to list/i);
  });

  it('maps in-app plan levels onto the same tiers', () => {
    expect(valueTierForLevel(1).key).toBe('basic');
    expect(valueTierForLevel(2).key).toBe('plus');
    expect(valueTierForLevel(0).key).toBe('trial');
  });
});

describe('pricing-content.tsx mounts the block and keeps the toggle intact', () => {
  /** The three <PlanCard …/> source spans, in page order: trial, basic, plus. */
  function planCards(): [string, string, string] {
    const starts = [...pricing.matchAll(/<PlanCard\b/g)].map((m) => m.index ?? -1);
    expect(starts).toHaveLength(3);
    const end = pricing.indexOf('</section>', starts[2]);
    expect(end).toBeGreaterThan(starts[2]);
    return [pricing.slice(starts[0], starts[1]), pricing.slice(starts[1], starts[2]), pricing.slice(starts[2], end)];
  }

  it('renders PricingValueBlock above the plan cards', () => {
    const blockAt = pricing.indexOf('<PricingValueBlock');
    const cardsAt = pricing.indexOf('<PlanCard');
    expect(blockAt).toBeGreaterThan(-1);
    expect(cardsAt).toBeGreaterThan(blockAt);
  });

  it('keeps coarse:min-h-11 beside each setPeriod call', () => {
    for (const period of ['monthly', 'yearly']) {
      const idx = pricing.indexOf(`setPeriod('${period}')`);
      expect(idx).toBeGreaterThan(-1);
      expect(pricing.slice(idx, idx + 260)).toContain('coarse:min-h-11');
    }
  });

  it('renders the per-day line UNDER the price, on paid tiers only', () => {
    expect(pricing).toMatch(/import \{[^}]*\bformatPerDay,\n\s+perDayCents,[^}]*\} from '@\/lib\/marketing\/value'/);
    expect(pricing).toContain("tr('pricingValue.perDay', { amount: formatPerDay(perDayCents(");
    expect(en['pricingValue.perDay']).toContain('{amount}');
    // Under, not instead of: the price row precedes the perDay line in PlanCard.
    const priceRow = pricing.indexOf('<span className="text-4xl font-black">{price}</span>');
    const perDayLine = pricing.indexOf('{perDay && <p');
    expect(priceRow).toBeGreaterThan(-1);
    expect(perDayLine).toBeGreaterThan(priceRow);
    // The billed-annually sub-line survives underneath it.
    expect(pricing.indexOf('{priceSub}')).toBeGreaterThan(perDayLine);
    // Only the two paid cards pass perDay; the trial card does not. The cards
    // are located by their <PlanCard boundaries: every visible name on them is
    // a catalogue key, so there is no English literal to search for.
    const [trialCard] = planCards();
    expect(trialCard).not.toContain('perDay=');
    expect(pricing.match(/perDay=\{(basic|plus)PerDay\}/g)).toHaveLength(2);
  });

  it('puts cancel-anytime under the Family+ price', () => {
    const [trialCard, basicCard, plusCard] = planCards();
    expect(plusCard).toContain("footnote={tr('pricingValue.cancelAnytime')}");
    expect(trialCard).not.toContain('footnote=');
    expect(basicCard).not.toContain('footnote=');
    expect(en['pricingValue.cancelAnytime']).toMatch(/your data stays/i);
  });

  it('lifts the tier positioning callouts to catalogue keys', () => {
    expect(pricing).toContain('tr(tier.positioningKey)');
    expect(pricing).not.toContain('Category creator');
    for (const tier of VALUE_TIERS) expect(en[tier.positioningKey]).toBeTypeOf('string');
  });

  it('takes the highlight rail from the six hero outcomes plus Kitchen Mode', () => {
    expect(pricing).toContain('HERO_OUTCOMES.map');
    expect(pricing).toContain("titleKey: 'pricingContent.kitchenMode'");
    expect(pricing).toContain("descKey: 'pricingContent.turnAnyTabletOrSmart'");
    // Every tile string is a key now — no English descriptions left inline.
    expect(pricing).not.toContain('Turn any tablet or smart display');
    expect(pricing).not.toContain('emoji');
  });

  it('takes the switching band as a prop rather than importing the server module', () => {
    expect(pricing).toContain('switching?: ReactNode');
    expect(pricing).not.toMatch(/from ['"]@\/lib\/i18n\/server['"]/);
    expect(pricing).not.toContain('smartImportsTheFeatureMostCompetitors');
    expect(page).toContain('<SwitchingBand compact />');
  });

  it('reads the three sources on the server and hands them down', () => {
    expect(page).toContain('sampleBriefNumbers()');
    expect(page).toContain('getPublishedCaseStudies()');
    expect(page).toContain('handledCompleted: stats.handledCompleted');
    // At most two case-study cards, gated on verified_at exactly as the homepage.
    expect(page).toContain('caseStudies.slice(0, 2)');
    expect(page).toContain('verified: Boolean(study.verifiedAt)');
    expect(pricing).toContain('{study.verified && (');
    expect(pricing).toContain("tr('socialProof.verifiedBadge')");
  });
});

describe('the in-app upgrade modal reuses the same arithmetic and copy', () => {
  it('derives its per-day lines from lib/marketing/value.ts', () => {
    expect(upgrade).toContain("from '@/lib/marketing/value'");
    expect(upgrade).toContain("formatPerDay(perDayCents(tier.monthlyCents, 'monthly'))");
    expect(upgrade).toContain("formatPerDay(perDayCents(tier.annualCents, 'yearly'))");
  });

  it('leads with the tier outcomes and keeps the checklist secondary', () => {
    expect(upgrade).toContain('valueTierForLevel(');
    const outcomesAt = upgrade.indexOf("t('planOutcomes.heading')");
    const featuresAt = upgrade.indexOf("t('upgradeModal.alsoIncluded')");
    expect(outcomesAt).toBeGreaterThan(-1);
    expect(featuresAt).toBeGreaterThan(outcomesAt);
  });

  it('no longer interpolates English into the modal chrome', () => {
    expect(upgrade).not.toContain('`Unlock ${featureLabel}`');
    expect(upgrade).not.toContain("'Redirecting…'");
    expect(upgrade).toContain("t('upgradeModal.unlockFeature', { feature: featureLabel })");
  });
});

describe('no competitor price appears anywhere on the pricing surface', () => {
  const COMPETITORS = /(Cozi|FamilyWall|OurHome|FamCal|Skylight)/;

  it('names competitors in the replacement line but never prices them', () => {
    expect(en['pricingValue.positioningBasic']).toMatch(/Cozi Gold/);
    for (const source of [pricing, block, page, upgrade]) {
      expect(source).not.toMatch(new RegExp(`${COMPETITORS.source}[^\\n]{0,60}\\$\\d`));
      expect(source).not.toMatch(new RegExp(`\\$\\d[^\\n]{0,60}${COMPETITORS.source}`));
      expect(source).not.toMatch(/\$\d+ (screen|display|frame)/);
    }
  });

  it('keeps the catalogue free of competitor prices and hourly comparisons', () => {
    for (const [key, value] of Object.entries(en)) {
      if (!key.startsWith('pricingValue.') && !key.startsWith('planOutcomes.')) continue;
      expect(value, key).not.toMatch(new RegExp(`${COMPETITORS.source}[^\\n]{0,60}\\$\\d`));
      expect(value, key).not.toMatch(/\bnanny\b|\bbabysitter\b|\bassistant\b.{0,20}\bper hour\b|\ban hour\b/i);
      expect(value, key).not.toMatch(/hours saved|saved \d+ hours|zero setup/i);
    }
  });
});
