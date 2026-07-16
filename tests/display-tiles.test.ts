import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILES, resolveTiles, tileRowSpan, isCompactTile, tileListLimit,
  TILE_SIZES,
} from '@/lib/display/tiles';

const uid = () => 'fresh';

describe('resolveTiles — the stored layout is untrusted input', () => {
  it('passes a valid saved layout through unchanged', () => {
    const saved = [
      { id: 'a', widget: 'schedule', size: 'md' },
      { id: 'b', widget: 'weather', size: 'sm' },
    ];
    expect(resolveTiles(saved, uid)).toEqual(saved);
  });

  it('REGRESSION: drops the literal nulls a sparse-array save leaves in jsonb (the kiosk SSR crash)', () => {
    const saved = [null, { id: 'a', widget: 'schedule', size: 'md' }, null, undefined];
    expect(resolveTiles(saved, uid)).toEqual([{ id: 'a', widget: 'schedule', size: 'md' }]);
  });

  it('drops strings, numbers, arrays and unknown widgets', () => {
    const saved = ['schedule', 42, ['weather'], { id: 'x', widget: 'renamed_widget', size: 'md' }, { id: 'a', widget: 'clock', size: 'sm' }];
    expect(resolveTiles(saved, uid)).toEqual([{ id: 'a', widget: 'clock', size: 'sm' }]);
  });

  it('coerces unknown sizes and mints missing ids', () => {
    expect(resolveTiles([{ widget: 'meals', size: 'xxl' }], uid))
      .toEqual([{ id: 'fresh', widget: 'meals', size: 'sm' }]);
  });

  it('falls back to the default layout for non-arrays and fully-invalid arrays', () => {
    expect(resolveTiles(null, uid)).toEqual(DEFAULT_TILES);
    expect(resolveTiles({ tiles: [] }, uid)).toEqual(DEFAULT_TILES);
    expect(resolveTiles([null, 'x', {}], uid)).toEqual(DEFAULT_TILES);
    expect(resolveTiles([], uid)).toEqual(DEFAULT_TILES);
  });
});

describe('tile size → vertical room (dynamic widget sizing)', () => {
  it('maps each size to a sensible row-span', () => {
    expect(tileRowSpan('sm')).toBe(1);
    expect(tileRowSpan('wide')).toBe(1);
    expect(tileRowSpan('md')).toBe(2);
    expect(tileRowSpan('lg')).toBe(2);
    expect(tileRowSpan('hero')).toBe(3);
  });

  it('flags only the one-row sizes as compact (drives condensed layouts)', () => {
    expect(isCompactTile('sm')).toBe(true);
    expect(isCompactTile('wide')).toBe(true);
    expect(isCompactTile('md')).toBe(false);
    expect(isCompactTile('lg')).toBe(false);
    expect(isCompactTile('hero')).toBe(false);
  });

  it('every valid size has a defined row-span', () => {
    for (const s of TILE_SIZES) expect(tileRowSpan(s)).toBeGreaterThanOrEqual(1);
  });

  it('list limits grow monotonically with tile height', () => {
    expect(tileListLimit('sm', 4)).toBe(4);
    expect(tileListLimit('md', 4)).toBe(9);
    expect(tileListLimit('hero', 4)).toBe(14);
    // taller is never fewer rows
    expect(tileListLimit('hero', 3)).toBeGreaterThan(tileListLimit('md', 3));
    expect(tileListLimit('md', 3)).toBeGreaterThan(tileListLimit('sm', 3));
  });
});

describe('service launcher tiles (any feature via the display editor)', () => {
  const uid = () => 'fresh';

  it('accepts a service tile with a valid internal href and preserves it', () => {
    const saved = [{ id: 's1', widget: 'service', size: 'sm', href: '/dashboard/groceries' }];
    expect(resolveTiles(saved, uid)).toEqual(saved);
  });

  it('accepts the catalog’s query/hash deep links', () => {
    const saved = [
      { id: 'a', widget: 'service', size: 'sm', href: '/dashboard?view=family' },
      { id: 'b', widget: 'service', size: 'sm', href: '/dashboard/settings#members' },
    ];
    expect(resolveTiles(saved, uid)).toEqual(saved);
  });

  it('drops service tiles with unsafe or missing hrefs', () => {
    const bad = [
      { id: 'a', widget: 'service', size: 'sm' },                                  // no href
      { id: 'b', widget: 'service', size: 'sm', href: 'https://evil.example' },    // absolute URL
      { id: 'c', widget: 'service', size: 'sm', href: '//evil.example' },          // protocol-relative
      { id: 'd', widget: 'service', size: 'sm', href: 'javascript:alert(1)' },     // scheme
      { id: 'e', widget: 'service', size: 'sm', href: '/x/y:z' },                  // colon anywhere
      { id: 'f', widget: 'service', size: 'sm', href: '/' + 'x'.repeat(200) },     // too long
    ];
    const keep = { id: 'ok', widget: 'service', size: 'md', href: '/wallet' };
    expect(resolveTiles([...bad, keep], uid)).toEqual([keep]);
  });

  it('strips a stray href stored on a built-in widget tile', () => {
    expect(resolveTiles([{ id: 'a', widget: 'clock', size: 'sm', href: '/x' }], uid))
      .toEqual([{ id: 'a', widget: 'clock', size: 'sm' }]);
  });
});
