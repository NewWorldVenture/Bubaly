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
