import { describe, it, expect } from 'vitest';
import {
  slugify,
  interpolate,
  resolveSlug,
  renderParagraphs,
  renderPage,
  mergeVars,
  hubSlug,
  type SeoTemplate,
} from '@/lib/seo/template';
import { US_STATES, stateVars } from '@/lib/seo/states';

describe('slugify', () => {
  it('lowercases, hyphenates, strips punctuation', () => {
    expect(slugify('New York')).toBe('new-york');
    expect(slugify("Washington, D.C.")).toBe('washington-dc');
    expect(slugify('  Family   Organizer!  ')).toBe('family-organizer');
  });
});

describe('interpolate', () => {
  const vars = { state: 'California', state_abbr: 'CA', product: 'Bubaly' };

  it('replaces known placeholders', () => {
    expect(interpolate('{product} for {state} families', vars)).toBe('Bubaly for California families');
  });

  it('drops unknown placeholders and tidies whitespace/punctuation', () => {
    expect(interpolate('Hello {missing} world', vars)).toBe('Hello world');
    expect(interpolate('Built in {missing}.', vars)).toBe('Built in.');
  });

  it('supports :upper / :lower / :slug filters', () => {
    expect(interpolate('{state_abbr:lower}', vars)).toBe('ca');
    expect(interpolate('{state:upper}', vars)).toBe('CALIFORNIA');
    expect(interpolate('{state:slug}', vars)).toBe('california');
  });

  it('returns empty string for null input', () => {
    expect(interpolate(null, vars)).toBe('');
  });
});

describe('hubSlug', () => {
  it('returns the static prefix before the first variable segment', () => {
    expect(hubSlug('family-organizer/{state_slug}')).toBe('family-organizer');
    expect(hubSlug('apps/family/{state}')).toBe('apps/family');
    expect(hubSlug('best-{state}-app')).toBe('');
  });
  it('returns empty when the first segment is a variable', () => {
    expect(hubSlug('{state_slug}/family')).toBe('');
  });
});

describe('resolveSlug', () => {
  it('resolves a multi-segment pattern and slugifies each segment', () => {
    expect(resolveSlug('family-organizer/{state_slug}', { state_slug: 'new-york' })).toBe('family-organizer/new-york');
    expect(resolveSlug('apps/{state}', { state: 'New York' })).toBe('apps/new-york');
  });

  it('drops empty segments from missing vars', () => {
    expect(resolveSlug('a/{missing}/b', {})).toBe('a/b');
  });
});

describe('renderParagraphs', () => {
  it('splits on blank lines and interpolates each paragraph', () => {
    const out = renderParagraphs('Hello {state}.\n\nSecond line for {state}.', { state: 'Texas' });
    expect(out).toEqual(['Hello Texas.', 'Second line for Texas.']);
  });
  it('returns [] for empty intro', () => {
    expect(renderParagraphs(null, {})).toEqual([]);
    expect(renderParagraphs('', {})).toEqual([]);
  });
});

const TEMPLATE: SeoTemplate = {
  id: 't1',
  name: 'Family Organizer by State',
  topic: 'family-organizer',
  slug_pattern: 'family-organizer/{state_slug}',
  eyebrow: '{product} · {state}',
  h1_template: 'The #1 Family Organizer App in {state}',
  subhead_template: 'Join {state} families staying organized with {product}.',
  meta_title_template: '{product} for {state} Families | Family Organizer App',
  meta_description_template: 'The best family organizer app for {state} households in {year}.',
  intro_template: 'Families across {state} use {product}.\n\nFrom calendars to chores.',
  feature_blocks: [
    { icon: 'Calendar', title: 'Shared calendar for {state} families', description: 'Sync everyone in {state}.' },
  ],
  faqs: [{ q: 'Is {product} available in {state}?', a: 'Yes — {product} works everywhere in {state}.' }],
  cta_label: 'Get {product} free',
  cta_href: '/signup',
  static_vars: { product: 'Bubaly' },
  is_active: true,
};

describe('mergeVars', () => {
  it('merges static vars, adds year, lets page vars win', () => {
    const merged = mergeVars(TEMPLATE, { state: 'Ohio', product: 'Override' });
    expect(merged.product).toBe('Override');
    expect(merged.state).toBe('Ohio');
    expect(merged.year).toMatch(/^\d{4}$/);
  });
});

describe('renderPage', () => {
  const page = renderPage(TEMPLATE, stateVars(US_STATES.find((s) => s.abbr === 'CA')!));

  it('resolves slug, meta, h1, subhead', () => {
    expect(page.slug).toBe('family-organizer/california');
    expect(page.h1).toBe('The #1 Family Organizer App in California');
    expect(page.metaTitle).toBe('Bubaly for California Families | Family Organizer App');
    expect(page.metaDescription).toContain('California');
    expect(page.subhead).toBe('Join California families staying organized with Bubaly.');
  });

  it('resolves paragraphs, features, faqs, cta', () => {
    expect(page.paragraphs).toEqual(['Families across California use Bubaly.', 'From calendars to chores.']);
    expect(page.features[0].title).toBe('Shared calendar for California families');
    expect(page.faqs[0].q).toBe('Is Bubaly available in California?');
    expect(page.ctaLabel).toBe('Get Bubaly free');
    expect(page.ctaHref).toBe('/signup');
  });

  it('falls back to h1 for meta title when none provided', () => {
    const bare = { ...TEMPLATE, meta_title_template: null };
    expect(renderPage(bare, { state: 'Iowa', state_slug: 'iowa' }).metaTitle).toBe('The #1 Family Organizer App in Iowa');
  });
});

describe('US_STATES dataset', () => {
  it('has 51 entries (50 states + DC) with unique slugs', () => {
    expect(US_STATES).toHaveLength(51);
    const slugs = new Set(US_STATES.map((s) => s.slug));
    expect(slugs.size).toBe(51);
  });
});
