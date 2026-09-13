import { describe, expect, it, vi } from 'vitest';
import { isSyntheticSeedSlug, publishedOnly } from '@/lib/marketing/reputation';
import { loadPublishedCaseStudy } from '@/lib/marketing/case-study-server';

/**
 * Verbatim from production on 2026-09-13. The homepage and /pricing both
 * rendered these three under the heading "Family stories", introduced as quotes
 * "In the family's own words", and /customers/seed-case_studies-450 answered
 * 200 with `<h1>Seed Case Studies #450</h1>`.
 *
 * `is_published` was true on every one of them — the seeder sets it — so the
 * publication flag could never have caught this.
 */
const SEEDED = [
  { id: '1', is_published: true, slug: 'seed-case_studies-450', title: 'Seed Case Studies #450' },
  { id: '2', is_published: true, slug: 'seed-case_studies-180', title: 'Seed Case Studies #180' },
  { id: '3', is_published: true, slug: 'seed-case_studies-90', title: 'Seed Case Studies #90' },
];

const REAL = { id: '4', is_published: true, slug: 'the-nguyen-family', title: 'The Nguyen family' };

describe('seeded case studies are never public', () => {
  it('recognises the seeder\'s slug convention', () => {
    for (const row of SEEDED) expect(isSyntheticSeedSlug(row.slug)).toBe(true);
    expect(isSyntheticSeedSlug('seed-blog_posts-3')).toBe(true);
    expect(isSyntheticSeedSlug('seed-testimonials-12')).toBe(true);
  });

  it('does not mistake a real story for a seeded one', () => {
    for (const slug of [
      'the-nguyen-family',
      'seeds-of-change',        // starts with "seed" but is a real word
      'seed-starting-with-kids', // a plausible gardening story
      'planting-seed-100',       // the marker is not at the start
    ]) {
      expect(isSyntheticSeedSlug(slug)).toBe(false);
    }
  });

  it('tolerates a missing or null slug', () => {
    // testimonials have no slug column at all; they must pass through.
    expect(isSyntheticSeedSlug(undefined)).toBe(false);
    expect(isSyntheticSeedSlug(null)).toBe(false);
  });

  it('keeps seeded rows out of the public list', () => {
    const visible = publishedOnly([...SEEDED, REAL]);
    expect(visible.map((r) => r.slug)).toEqual(['the-nguyen-family']);
  });

  it('still shows published rows without a slug (testimonials)', () => {
    const testimonials = [
      { id: 't1', is_published: true, quote: 'It gave us our evenings back.' },
      { id: 't2', is_published: false, quote: 'unpublished' },
    ];
    expect(publishedOnly(testimonials).map((t) => t.id)).toEqual(['t1']);
  });

  it('404s a seeded story on its detail page without querying', async () => {
    // The list and the detail page must agree. A link that survived in a cache
    // or a search index must not still render one.
    const from = vi.fn();
    const db = { from } as never;

    const result = await loadPublishedCaseStudy(db, 'seed-case_studies-450');

    expect(result).toEqual({ ok: true, study: null });
    // Refused before the database is touched at all.
    expect(from).not.toHaveBeenCalled();
  });

  it('still reads a real story on its detail page', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: { ...REAL, customer_name: 'Nguyen', summary: 's', body: 'b', result_metric: 'm' },
      error: null,
    }));
    const chain = { select: () => chain, eq: () => chain, maybeSingle } as never;
    const db = { from: () => chain } as never;

    const result = await loadPublishedCaseStudy(db, 'the-nguyen-family');

    expect(result).toMatchObject({ ok: true, study: { slug: 'the-nguyen-family' } });
    expect(maybeSingle).toHaveBeenCalled();
  });
});
