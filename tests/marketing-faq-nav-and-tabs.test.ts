import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MARKETING_NAV } from '@/lib/constants/navigation';
import { FaqExplorer, type FaqTopic } from '@/components/marketing/faq-explorer';
import prices from '@/lib/constants/family-prices.json';

// User requests, in order: (1) add FAQ to the marketing global nav between
// Pricing and Security → /faq; (2) reorganize the FAQ page into sections;
// (3) make /faq a world-class help centre — every topic on one page, a live
// search, deep links to each answer, and answers that are true today.
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

const page = readFileSync('app/(marketing)/faq/page.tsx', 'utf8');
const explorerSource = readFileSync('components/marketing/faq-explorer.tsx', 'utf8');
const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const BASE_LOCALES = ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];

/** The module-level FAQ_SECTIONS block, as written. */
const sectionsBlock = page.slice(page.indexOf('const FAQ_SECTIONS'), page.indexOf('/** The chips under the search box'));
const sectionIds = [...sectionsBlock.matchAll(/^ {4}id: '([a-z-]+)'/gm)].map((m) => m[1]);
const questionIds = [...sectionsBlock.matchAll(/\{ id: '([a-z-]+)', q: /g)].map((m) => m[1]);
const keysInPage = [...page.matchAll(/'((?:faq|security)\.[A-Za-z0-9]+)'/g)].map((m) => m[1]);
const hrefs = [...sectionsBlock.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);

describe('the FAQ page holds every topic on one page', () => {
  it('keeps the six original sections and adds the new ones', () => {
    for (const id of ['privacy-security', 'roles-access', 'ai-assistant', 'kids-safety', 'plans-pricing', 'mobile-notifications']) {
      expect(sectionIds, `section ${id}`).toContain(id);
    }
    for (const id of ['getting-started', 'calendars-imports']) expect(sectionIds).toContain(id);
  });

  it('gives every question a unique anchor', () => {
    expect(questionIds.length).toBeGreaterThanOrEqual(35);
    expect(new Set(questionIds).size).toBe(questionIds.length);
    // A question id is also a DOM id beside the topic headings' `topic-…` ids.
    for (const id of questionIds) expect(id.startsWith('topic-')).toBe(false);
  });

  it('points the popular chips at questions that exist', () => {
    const popular = page.match(/const POPULAR = \[([^\]]+)\]/)?.[1] ?? '';
    const ids = [...popular.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect(questionIds).toContain(id);
  });

  it('resolves only keys the catalogue has, in English and in every base translation', () => {
    expect(keysInPage.length).toBeGreaterThan(80);
    const catalogues = Object.fromEntries(BASE_LOCALES.map((code) => [code, JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>]));
    for (const key of keysInPage) {
      expect(en[key], key).toBeTruthy();
      for (const code of BASE_LOCALES) expect(catalogues[code][key], `${code} ${key}`).toBeTruthy();
    }
  });

  it('links each "learn more" to a public page that exists', () => {
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) {
      const path = href.split('#')[0];
      expect(existsSync(`app/(marketing)${path}/page.tsx`), href).toBe(true);
    }
  });

  it('adds the live Knowledge Center as its own section when answers exist', () => {
    expect(page).toContain("id: 'knowledge-center'");
    expect(page).toContain('knowledge.length > 0');
  });

  it('keeps every answer in the FAQPage structured data', () => {
    expect(page).toContain('sections.flatMap((section) => section.items)');
    expect(page).toContain('<FaqStructuredData items={schemaItems} />');
  });

  it('renders the explorer with one h1 above it', () => {
    expect(page).toContain('<FaqExplorer topics={sections} popular={POPULAR} />');
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    expect(explorerSource).not.toMatch(/<h1\b/);
  });
});

describe('the answers say what the product does today', () => {
  const answer = (key: string) => en[key] ?? '';

  it('starts every family on the 5-day Family Basic trial, with no card — not a free plan', () => {
    expect(answer('faq.whatDoesItCostA')).toMatch(/5-day trial of Family Basic/);
    expect(answer('faq.whatDoesItCostA')).toMatch(/no credit card/i);
    // The answer this replaced promised "a free Starter plan", which new
    // families never get: an expired trial locks (lib/server/entitlement.ts).
    expect(page).not.toContain('faq.thereSAFreeStarter');
    const faqCopy = Object.entries(en).filter(([key]) => key.startsWith('faq.')).map(([, value]) => value).join('\n');
    expect(faqCopy).not.toMatch(/free (Starter )?plan/i);
    expect(answer('faq.trialEndsA')).toMatch(/locks/);
  });

  it('quotes the annual saving from the price file, not from memory', () => {
    expect(answer('faq.whatDoesItCostA')).toContain(`${prices.annualSavingsPercent}%`);
  });

  it('never prints a price, so the answer cannot fall behind the price file or the reader\'s currency', () => {
    for (const [key, value] of Object.entries(en)) {
      if (key.startsWith('faq.')) expect(value, key).not.toMatch(/[$€£]\s?\d/);
    }
  });

  it('describes the assistant\'s limits the way the Trust Center does', () => {
    expect(answer('faq.aiAsksFirstA')).toMatch(/Recommend, Prepare or Execute/);
    expect(answer('faq.aiAsksFirstA')).toMatch(/always wait for a parent/);
    expect(answer('faq.aiTrainingA')).toMatch(/never used to train models/);
  });

  it('reuses the Trust Center\'s own answers rather than restating them', () => {
    for (const key of ['security.faqEncryptionQ', 'security.faqSellDataQ', 'security.faqRegionQ', 'security.faqReportQ', 'security.faqChildrenQ']) {
      expect(page).toContain(`'${key}'`);
    }
  });
});

describe('the FAQ explorer', () => {
  const topics: FaqTopic[] = [
    { id: 'alpha', label: 'Alpha', blurb: 'First topic', icon: 'start', items: [
      { id: 'one', q: 'Question one?', a: 'Answer one.', links: [{ href: '/pricing', label: 'Pricing' }] },
      { id: 'two', q: 'Question two?', a: 'Answer two.' },
    ] },
    { id: 'beta', label: 'Beta', blurb: 'Second topic', icon: 'privacy', items: [
      { id: 'three', q: 'Question three?', a: 'Answer three.' },
    ] },
  ];
  const html = renderToStaticMarkup(createElement(FaqExplorer, { topics, popular: ['two', 'missing'] }));

  it('server-renders every question as a native disclosure, answer included', () => {
    // <details> opens without script, the browser's find-in-page reaches a
    // closed answer, and crawlers read every answer the FAQPage schema names.
    expect(html.match(/<details\b/g)).toHaveLength(3);
    for (const text of ['Answer one.', 'Answer two.', 'Answer three.']) expect(html).toContain(text);
    expect(html).toContain('id="one"');
    expect(html).toContain('<summary');
  });

  it('gives every topic a heading the topic grid and side nav link to', () => {
    expect(html).toContain('id="topic-alpha"');
    expect(html).toContain('href="#topic-beta"');
    expect(html).toContain('aria-labelledby="topic-alpha"');
  });

  it('links a popular question by its anchor and skips one that does not exist', () => {
    expect(html).toContain('href="#two"');
    expect(html).not.toContain('href="#missing"');
  });

  it('labels the search field and announces the result count', () => {
    expect(html).toContain('role="search"');
    expect(html).toMatch(/<label[^>]*for="faq-search"/);
    expect(html).toContain('aria-live="polite"');
  });

  it('renders the learn-more link under its answer', () => {
    expect(html).toContain('href="/pricing"');
  });

  it('is touch-friendly and keyboard-reachable', () => {
    expect(explorerSource).toContain('min-h-14'); // each question row
    expect(explorerSource).toContain('focus-ring');
    expect(explorerSource).toContain("event.key !== '/'");
    expect(explorerSource).toContain("event.key === 'Escape'");
  });
});

// The display story: "a shared family screen on the tablet you already own".
// The FAQ answer, the /mobile section and the footer all point at the same
// anchor, so the anchor has to exist and the answer has to be catalogue copy.
describe('the Kitchen Mode entry', () => {
  const features = readFileSync('components/marketing/reference-showcases.tsx', 'utf8');
  const mobile = readFileSync('app/(marketing)/mobile/page.tsx', 'utf8');

  it('joins the mobile-notifications section from the catalogue, not as a literal', () => {
    // FAQ_SECTIONS holds catalogue keys and the page resolves them at render
    // time, so the entry is two keys inside its own section — never English.
    const start = page.indexOf("id: 'mobile-notifications'");
    expect(start).toBeGreaterThan(-1);
    const mobileSection = page.slice(start, page.indexOf('\n  },', start));
    expect(mobileSection).toContain("q: 'faq.kitchenModeQ', a: 'faq.kitchenModeA'");
    expect(page).toContain('q: t(item.q),');
    expect(page).toContain('a: t(item.a),');
    expect(en['faq.kitchenModeQ']).toBeTruthy();
    expect(en['faq.kitchenModeA']).toBeTruthy();
  });

  it('lives in exactly one section', () => {
    expect(page.match(/faq\.kitchenModeQ/g)).toHaveLength(1);
    expect(page.slice(0, page.indexOf("id: 'mobile-notifications'"))).not.toContain('faq.kitchenMode');
    expect(page).toContain('const core: FaqTopic[] = FAQ_SECTIONS.map((section) => ({');
  });

  it.each(['kitchen-mode', 'switching'])('/features#%s is a real anchor', (id) => {
    expect(features).toContain(`id="${id}"`);
    // FeatureCard renders the id on an <article> that clears the sticky header.
    expect(features).toContain('scroll-mt-24');
  });

  it('sends /mobile and the answer to that anchor rather than a dead link', () => {
    expect(mobile).toContain('href="/features#kitchen-mode"');
    expect(page).toContain("href: '/features#kitchen-mode'");
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
