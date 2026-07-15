import { describe, expect, it } from 'vitest';
import { DEFAULT_TILES, resolveTiles } from '@/lib/display/tiles';

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
