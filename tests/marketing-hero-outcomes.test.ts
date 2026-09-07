import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HERO_OUTCOMES, MORE_OUTCOMES } from '@/lib/marketing/hero-outcomes';
import { highStakesGroups, trustDomainKey, trustGroupKey } from '@/lib/marketing/trust-copy';
import { OUTCOMES_BY_ID } from '@/lib/outcomes/launcher';
import { DOMAIN_LABELS, HIGH_STAKES_AI_DOMAINS, ROLE_DEFAULTS } from '@/lib/trust/engine';

// The homepage leads with six outcomes. This pins what the e2e suite walks
// (tests/e2e/marketing-public.spec.ts: six links, unique hrefs, the first one
// landing on /features#smart-calendar) at source level, and pins the honesty
// rules around them: every "asks first" domain is one the trust engine really
// guards, no headline says "AI", and the kids' sign-off line is only claimed
// while the engine actually withholds automation from the child role.
const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const rail = readFileSync('components/marketing/hero-outcomes.tsx', 'utf8');
const showcases = readFileSync('components/marketing/reference-showcases.tsx', 'utf8');

const E2E_ORDER = [
  '/features#smart-calendar',
  '/features#tasks-chores',
  '/features#meal-planning',
  '/features#school-hub',
  '/features#health-medications',
  '/features#home-management',
];

describe('HERO_OUTCOMES registry', () => {
  it('has exactly six entries', () => {
    expect(HERO_OUTCOMES).toHaveLength(6);
  });

  it('maps every entry to a real in-app outcome', () => {
    for (const outcome of HERO_OUTCOMES) {
      expect(OUTCOMES_BY_ID[outcome.outcomeId], outcome.titleKey).toBeTruthy();
    }
    for (const more of MORE_OUTCOMES) {
      expect(OUTCOMES_BY_ID[more.outcomeId], more.labelKey).toBeTruthy();
    }
  });

  it('links the six /features cards in the order the e2e suite walks', () => {
    const hrefs = HERO_OUTCOMES.map((o) => o.href);
    expect(new Set(hrefs).size).toBe(6);
    expect(hrefs).toEqual(E2E_ORDER);
  });

  it('every copy key exists in the English catalogue', () => {
    for (const outcome of HERO_OUTCOMES) {
      for (const key of [outcome.titleKey, outcome.bodyKey, outcome.proofKey, outcome.roleAsksKey, outcome.trustChipKey]) {
        if (!key) continue;
        expect(en[key], key).toBeTruthy();
      }
    }
    for (const more of MORE_OUTCOMES) expect(en[more.labelKey], more.labelKey).toBeTruthy();
    for (const key of ['heroOutcomes.eyebrow', 'heroOutcomes.title', 'heroOutcomes.asksFirst', 'heroOutcomes.asksNothing', 'heroOutcomes.moreTitle', 'heroOutcomes.moreLink', 'root.exploreFamilyTools']) {
      expect(en[key], key).toBeTruthy();
    }
  });

  it('only asks first about domains the trust engine actually guards, through catalogue keys that match the engine labels', () => {
    for (const outcome of HERO_OUTCOMES) {
      for (const domain of outcome.asksFirst) {
        expect(HIGH_STAKES_AI_DOMAINS, `${outcome.titleKey} asks about ${domain}`).toContain(domain);
        expect(en[trustDomainKey(domain)], trustDomainKey(domain)).toBe(DOMAIN_LABELS[domain]);
      }
    }
  });
});

describe('the always-asks partition', () => {
  it('flattens to exactly HIGH_STAKES_AI_DOMAINS', () => {
    const groups = highStakesGroups();
    const flat = Object.values(groups).flat();
    expect(new Set(flat)).toEqual(new Set(HIGH_STAKES_AI_DOMAINS));
    expect(flat).toHaveLength(HIGH_STAKES_AI_DOMAINS.length);
  });

  it('has a catalogue label for every guarded domain and every group heading', () => {
    for (const domain of HIGH_STAKES_AI_DOMAINS) {
      expect(en[trustDomainKey(domain)], domain).toBe(DOMAIN_LABELS[domain]);
    }
    for (const group of Object.keys(highStakesGroups()) as Parameters<typeof trustGroupKey>[0][]) {
      expect(en[trustGroupKey(group)], group).toBeTruthy();
    }
  });
});

describe('the /features cards the rail deep-links to', () => {
  // The two further cards the footer and the Kitchen Mode band point at
  // (id="kitchen-mode", id="switching") arrive with the /features stage of the
  // public-site plan, which adds them to this list.
  it.each(E2E_ORDER.map((href) => href.slice(href.indexOf('#') + 1)))('id="%s" exists in reference-showcases.tsx', (id) => {
    expect(showcases).toContain(`id="${id}"`);
  });
});

describe('outcome-first copy', () => {
  it('never puts "AI" in a hero or outcome headline', () => {
    const offenders = Object.entries(en)
      .filter(([key]) => key.startsWith('heroOutcomes.') || key.startsWith('homeHero.'))
      .filter(([, value]) => /\bAI\b/.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("claims the kids' sign-off line only while the engine withholds automation from children", () => {
    if (rail.includes('heroOutcomes.choresAsks') || HERO_OUTCOMES.some((o) => o.roleAsksKey === 'heroOutcomes.choresAsks')) {
      expect(ROLE_DEFAULTS.child.automationTrusted).toBe(false);
    }
    // And the render gate is mechanical, not a comment.
    expect(rail).toContain('ROLE_DEFAULTS.child.automationTrusted === false');
  });

  it('keeps the rail nav to the six outcome links (the trust chip is a span, not a link)', () => {
    expect(rail).toContain("aria-label={t('root.exploreFamilyTools')}");
    const nav = rail.slice(rail.indexOf('<nav'), rail.indexOf('</nav>'));
    expect(nav.match(/<Link\b/g)?.length).toBe(1);
    expect(nav).not.toContain('<a ');
    expect(nav).not.toContain('shadow-');
  });
});
