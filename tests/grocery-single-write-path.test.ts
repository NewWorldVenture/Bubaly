// One door into `grocery_items`, and an honest account of what is outside it.
//
// The companion to `grocery-write-path.test.ts`: that file proves the action is
// right, this one proves the modules call it. A client component with hooks does
// not render under `environment: 'node'`, and a passing action is exactly what a
// module still inserting straight into PostgREST would leave behind.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The three modules a family actually reaches that add to the grocery list. */
const SURFACE = [
  'components/modules/shopping-module.tsx',
  'components/modules/pantry-module.tsx',
  'components/modules/recipes-module.tsx',
];

/**
 * `components/modules/grocery-module.tsx` is NOT on that list, and not because
 * it was skipped: nothing imports it. `/dashboard/grocery` renders
 * `ShoppingModule`, there is no barrel and no dynamic import, and the only other
 * mention of the file in the repository is a ratchet listing it by name. It is a
 * second, unreachable copy of the shopping list — so "fixing" its insert would
 * have changed a file no family loads while the live one kept duplicating milk.
 */
const DEAD_MODULE = 'components/modules/grocery-module.tsx';

const WRITE = /\.from\(\s*['"]grocery_items['"]\s*\)[\s\S]{0,200}?\.(insert|upsert)\s*\(/g;

/** Comments out, code in — a file explaining what it no longer does will name it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

function insertsIn(file: string): string[] {
  return [...code(file).matchAll(WRITE)].map((m) => m[1]!);
}

describe('the grocery surface adds through the service', () => {
  it.each(SURFACE)('%s issues no direct insert into grocery_items', (file) => {
    expect(insertsIn(file)).toEqual([]);
  });

  it.each(SURFACE)('%s reaches the list through the server action instead', (file) => {
    expect(code(file)).toMatch(/from '@\/app\/\(app\)\/dashboard\/grocery\/actions'/);
  });

  it.each(SURFACE)('%s tells the family when an add was skipped', (file) => {
    // The whole point of routing through the service is that it KNOWS milk was
    // already there. A surface that drops `skipped` on the floor has taken the
    // duplicate away and put silence in its place, which is not obviously better.
    expect(code(file)).toMatch(/from '@\/lib\/groceries\/add-summary'/);
    expect(code(file)).toMatch(/groceryAddWasNoOp\(/);
  });

  it('no longer needs a cast to write a column 0014 added', () => {
    // `grocery_lists` gained store/list_icon/list_color/sort_order/archived_at in
    // 0014 and lib/database.types.ts never caught up, so every write naming one
    // carried `as never` — which also silences real mistakes.
    expect(code('components/modules/shopping-module.tsx')).not.toMatch(/as never/);
  });

  it('asks both archive columns what "open" means, everywhere it asks', () => {
    // Nothing sets `is_archived`; the only archive writer stamps `archived_at`.
    // A reader that consults one column calls a family's archived list their
    // open one, so every open-list lookup has to consult both.
    const lookups = [
      'lib/services/groceries/index.ts',
      'components/modules/recipes-module.tsx',
    ];
    for (const file of lookups) {
      const src = code(file);
      const byFlag = (src.match(/\.eq\('is_archived', false\)/g) ?? []).length;
      const byStamp = (src.match(/\.is\('archived_at', null\)/g) ?? []).length;
      expect(byFlag, `${file} has open-list lookups`).toBeGreaterThan(0);
      expect(byStamp, `${file} checks archived_at as often as is_archived`).toBe(byFlag);
    }
  });

  it('names the unreachable duplicate rather than quietly converting it', () => {
    // Fails the day someone deletes it or wires it up — either is a deliberate
    // act that should edit this list, not drift past it.
    expect(insertsIn(DEAD_MODULE).length, 'still the old client-side insert').toBeGreaterThan(0);
    expect(code(DEAD_MODULE)).not.toMatch(/from '@\/app\/\(app\)\/dashboard\/grocery\/actions'/);
  });
});
