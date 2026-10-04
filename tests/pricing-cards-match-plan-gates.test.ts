import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { AI_MONTHLY_ALLOWANCE } from '@/lib/server/ai-access';
import { VALUE_TIERS } from '@/lib/marketing/value';

// The /pricing plan cards are hand-written lists; what a family can actually
// open is decided by the feature catalogue (plus admin overrides, which the
// live matrix on the same page renders). The cards had drifted from it: Family
// Basic promised the Daily Briefing, Rewards and the Sports hub — all gated at
// Family+ — while the AI Concierge, gated at Basic, was sold as a Family+
// extra. And the trial card, under "Your free trial includes Family Basic:",
// listed "Up to 5 family members" and "10 AI requests/month", while a family in
// its trial is resolved to Basic (lib/server/entitlement.ts), whose AI
// allowance is unlimited.
//
// Each card item that names a gated feature is mapped to its catalogue key
// here, so moving a feature between tiers fails this test until the card moves
// with it.
const CARD_ITEM_FEATURE: Record<string, string> = {
  'pricingContent.chores': 'tasks-chores',
  'pricingContent.mealPlanning': 'meals',
  'pricingContent.groceryPlanning': 'groceries',
  'pricingContent.schoolHub': 'school',
  'pricingContent.rewards': 'rewards',
  'pricingContent.sportsHub': 'sports',
  'pricingContent.kitchenDisplayMode': 'kitchen',
  'pricingContent.aiConcierge': 'ai-concierge',
  'pricingContent.aiSchoolAssistant': 'school-os',
  'pricingContent.aiSportsAssistant': 'sports',
  'pricingContent.aiFamilyBriefings': 'daily-briefing',
  'pricingContent.aiFamilyCommandCenter': 'command-center',
  'pricingContent.familyDigitalTwin': 'digital-health',
};

const source = readFileSync('app/(marketing)/pricing/pricing-content.tsx', 'utf8');

/** Every catalogue key a card block names, as a section title or an item. */
function keysIn(name: 'FREE_FEATURES' | 'BASIC_FEATURES' | 'PLUS_FEATURES'): string[] {
  const start = source.indexOf(`const ${name} = [`);
  expect(start, name).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('];', start));
  return [...block.matchAll(/'(pricingContent\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
}

const tierOf = (cardKey: string) => FEATURE_CATALOG_BY_KEY[CARD_ITEM_FEATURE[cardKey]]?.defaultTier;

describe('the /pricing plan cards sell what each plan unlocks', () => {
  it('maps to catalogue features that exist', () => {
    for (const feature of Object.values(CARD_ITEM_FEATURE)) {
      expect(FEATURE_CATALOG_BY_KEY[feature], feature).toBeTruthy();
    }
  });

  it('lists nothing on the Family Basic card that only Family+ opens', () => {
    const gated = keysIn('BASIC_FEATURES').filter((key) => key in CARD_ITEM_FEATURE);
    expect(gated.length).toBeGreaterThan(3);
    for (const key of gated) expect([key, tierOf(key)]).not.toEqual([key, 'plus']);
  });

  it('adds only Family+ features under "Everything in Family Basic, plus:"', () => {
    const gated = keysIn('PLUS_FEATURES').filter((key) => key in CARD_ITEM_FEATURE);
    expect(gated.length).toBeGreaterThan(3);
    for (const key of gated) expect([key, tierOf(key)]).toEqual([key, 'plus']);
  });

  it('does not cap the trial below the Family Basic it gives', () => {
    // A trialing family resolves to level 1, and level 1's allowance is unlimited.
    expect(AI_MONTHLY_ALLOWANCE[1]).toBeNull();
    const trial = keysIn('FREE_FEATURES');
    expect(trial).not.toContain('pricingContent.upTo5FamilyMembers');
    expect(trial).not.toContain('pricingContent.tenAiRequestsMonth');
    expect(trial).toContain('pricingContent.unlimitedAiDuringTrial');
    // Basic adds to the trial card's list rather than to "your trial", which is Basic.
    expect(source).not.toContain('everythingInYourTrialPlus');
  });

  it('keeps the plan outcomes on the same side of the line', () => {
    const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    const text = (tier: string) => VALUE_TIERS.find((t) => t.key === tier)!.outcomes.map((o) => en[o.labelKey]).join('\n');
    expect(text('trial')).not.toMatch(/\bten\b|\b10\b/i);
    expect(text('basic')).not.toMatch(/daily brief/i);
    expect(en['pricingValue.basicPrepares']).not.toMatch(/daily brief/i);
    expect(en['pricingValue.trialHandles']).not.toMatch(/\bten\b|\b10\b/i);
  });
});
