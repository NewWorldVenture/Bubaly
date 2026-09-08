import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MARKETING_NAV } from '@/lib/constants/navigation';

// User request: (1) add FAQ to the marketing global nav between Pricing and
// Security → /faq; (2) reorganize the FAQ page into sectioned, mobile-first,
// accessible tabs.
describe('marketing FAQ nav item', () => {
  it('links /faq with the FAQ label', () => {
    const faq = MARKETING_NAV.find((i) => i.href === '/faq');
    expect(faq).toBeTruthy();
    expect(faq?.label).toBe('FAQ');
  });

  it('sits immediately after Pricing and before Security', () => {
    const hrefs = MARKETING_NAV.map((i) => i.href);
    const pricing = hrefs.indexOf('/pricing');
    const faq = hrefs.indexOf('/faq');
    const security = hrefs.indexOf('/security');
    expect(pricing).toBeGreaterThanOrEqual(0);
    expect(faq).toBe(pricing + 1);
    expect(security).toBe(faq + 1);
  });
});

describe('FAQ tabs component', () => {
  const src = readFileSync('components/marketing/faq-tabs.tsx', 'utf8');

  it('is an accessible WAI-ARIA tablist (roving tabindex + keyboard nav)', () => {
    expect(src).toContain("role=\"tablist\"");
    expect(src).toContain("role=\"tab\"");
    expect(src).toContain("role=\"tabpanel\"");
    expect(src).toContain('aria-selected={selected}');
    expect(src).toContain('tabIndex={selected ? 0 : -1}');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(src, `keyboard: ${key}`).toContain(`'${key}'`);
    }
  });

  it('is mobile-first: the tab strip scrolls horizontally then wraps/centres', () => {
    expect(src).toContain('overflow-x-auto');
    expect(src).toContain('sm:flex-wrap');
    expect(src).toContain('sm:justify-center');
    expect(src).toContain('min-h-[44px]'); // touch target
  });
});

describe('FAQ page uses sectioned tabs', () => {
  const page = readFileSync('app/(marketing)/faq/page.tsx', 'utf8');

  it('renders FaqTabs over grouped sections (not a single flat accordion)', () => {
    expect(page).toContain('<FaqTabs sections={sections} />');
    expect(page).toContain('const FAQ_SECTIONS: FaqSection[]');
    for (const id of ['privacy-security', 'roles-access', 'ai-assistant', 'kids-safety', 'plans-pricing', 'mobile-notifications']) {
      expect(page, `section ${id}`).toContain(`id: '${id}'`);
    }
  });

  it('adds the live Knowledge Center as its own tab when answers exist', () => {
    expect(page).toContain("id: 'knowledge-center'");
    expect(page).toContain('knowledge.length > 0');
  });

  it('keeps every answer in the FAQPage structured data', () => {
    expect(page).toContain('sections.flatMap((section) => section.items)');
    expect(page).toContain('<FaqStructuredData items={schemaItems} />');
  });
});

// The display story: "a shared family screen on the tablet you already own".
// The FAQ answer, the /mobile section and the footer all point at the same
// anchor, so the anchor has to exist and the answer has to be catalogue copy.
describe('the Kitchen Mode entry', () => {
  const page = readFileSync('app/(marketing)/faq/page.tsx', 'utf8');
  const features = readFileSync('components/marketing/reference-showcases.tsx', 'utf8');
  const mobile = readFileSync('app/(marketing)/mobile/page.tsx', 'utf8');
  const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

  it('joins the mobile-notifications section from the catalogue, not as a literal', () => {
    // FAQ_SECTIONS holds catalogue keys and the page resolves them at render
    // time, so the entry is two keys inside its own section — never English.
    const start = page.indexOf("id: 'mobile-notifications'");
    expect(start).toBeGreaterThan(-1);
    const mobileSection = page.slice(start, page.indexOf(']', start));
    expect(mobileSection).toContain("{ q: 'faq.kitchenModeQ', a: 'faq.kitchenModeA' }");
    expect(page).toContain('items: section.items.map((item) => ({ q: t(item.q), a: t(item.a) }))');
    expect(en['faq.kitchenModeQ']).toBeTruthy();
    expect(en['faq.kitchenModeA']).toBeTruthy();
  });

  it('leaves the other sections untouched', () => {
    // The entry lives in exactly one section, and every section still goes
    // through the same map, so the tab set and its order are unchanged.
    expect(page.match(/faq\.kitchenModeQ/g)).toHaveLength(1);
    expect(page.slice(0, page.indexOf("id: 'mobile-notifications'"))).not.toContain('faq.kitchenMode');
    expect(page).toContain('const core: FaqSection[] = FAQ_SECTIONS.map((section) => ({');
  });

  it.each(['kitchen-mode', 'switching'])('/features#%s is a real anchor', (id) => {
    expect(features).toContain(`id="${id}"`);
    // FeatureCard renders the id on an <article> that clears the sticky header.
    expect(features).toContain('scroll-mt-24');
  });

  it('sends /mobile and the answer to that anchor rather than a dead link', () => {
    expect(mobile).toContain('href="/features#kitchen-mode"');
  });

  it('never promises hardware Bubaly does not ship, and never prices a rival', () => {
    const copy = Object.entries(en)
      .filter(([key]) => key.startsWith('kitchenMode.') || key.startsWith('faq.kitchenMode') || key.startsWith('mobile.kitchenMode') || key === 'featureCards.kitchenMode' || key === 'featureCards.kitchenModeBody')
      .map(([, value]) => value)
      .join('\n');
    expect(copy).toBeTruthy();
    for (const claim of [/certified hardware/i, /PIN lock/i, /voice control/i, /burn-?in/i, /\$\d/]) {
      expect(copy, String(claim)).not.toMatch(claim);
    }
    // What it may say instead: the hardware is already in the house.
    expect(copy).toMatch(/no new hardware|no extra hardware/i);
  });
});
