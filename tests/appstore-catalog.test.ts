import { describe, it, expect } from 'vitest';
import { filterApps, rankApps, recommendedApps, categoryLabel, type CatalogApp } from '@/lib/appstore/catalog';

const app = (over: Partial<CatalogApp>): CatalogApp => ({
  id: over.id ?? 'a', slug: over.slug ?? 's', name: over.name ?? 'App', tagline: over.tagline ?? null,
  category: over.category ?? 'other', emoji: null, publisher: over.publisher ?? 'Bubaly',
  capabilities: over.capabilities ?? [], is_official: over.is_official ?? false,
  rating: over.rating ?? null, install_count: over.install_count ?? 0, status: over.status ?? 'published',
});

describe('filterApps', () => {
  const apps = [
    app({ id: '1', name: 'Meal Genie', category: 'meals' }),
    app({ id: '2', name: 'Chore Coach', category: 'chores', capabilities: ['sends_reminders'] }),
    app({ id: '3', name: 'Old One', category: 'meals', status: 'retired' }),
  ];
  it('filters by category', () => {
    expect(filterApps(apps, { category: 'meals' }).map((a) => a.id)).toEqual(['1']);
  });
  it('excludes retired apps', () => {
    expect(filterApps(apps).some((a) => a.id === '3')).toBe(false);
  });
  it('matches query across name/tagline/publisher/capabilities', () => {
    expect(filterApps(apps, { q: 'reminders' }).map((a) => a.id)).toEqual(['2']);
  });
  it('all category returns everything non-retired', () => {
    expect(filterApps(apps, { category: 'all' }).length).toBe(2);
  });
});

describe('rankApps', () => {
  it('official first, then rating, then installs', () => {
    const ranked = rankApps([
      app({ id: 'a', is_official: false, rating: 5 }),
      app({ id: 'b', is_official: true, rating: 4 }),
      app({ id: 'c', is_official: true, rating: 4, install_count: 999 }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('recommendedApps', () => {
  const apps = [
    app({ id: '1', category: 'meals', rating: 4, is_official: true }),
    app({ id: '2', category: 'school', rating: 5, is_official: false }),
    app({ id: '3', category: 'meals', rating: 3, status: 'coming_soon' }),
  ];
  it('biases to engaged categories and excludes installed + coming_soon', () => {
    const rec = recommendedApps(apps, { engagedCategories: ['meals'], installedIds: new Set(['9']), limit: 3 });
    expect(rec[0].id).toBe('1');            // meals engaged beats higher-rated school
    expect(rec.some((a) => a.id === '3')).toBe(false); // coming_soon excluded
  });
  it('excludes already-installed apps', () => {
    const rec = recommendedApps(apps, { installedIds: new Set(['1']) });
    expect(rec.some((a) => a.id === '1')).toBe(false);
  });
});

describe('categoryLabel', () => {
  it('maps known keys and falls back to Other', () => {
    expect(categoryLabel('meals')).toBe('Meals');
    expect(categoryLabel('nope')).toBe('Other');
  });
});
