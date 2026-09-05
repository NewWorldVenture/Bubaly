import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/inventory-module.tsx', 'utf8');
function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}
function bodies(fn: string): string[] {
  const out: string[] = []; let from = 0;
  for (;;) {
    const start = src.indexOf(`async function ${fn}(`, from);
    if (start === -1) break;
    const after = src.indexOf('async function ', start + 1);
    out.push(src.slice(start, after === -1 ? undefined : after)); from = start + 1;
  }
  return out;
}

describe('inventory-module writes fail visibly', () => {
  for (const fn of ['deleteItem', 'setStatus', 'deleteLocation']) {
    it(`${fn} guards its Supabase result`, () => {
      const b = body(fn);
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toContain('toastError(describeDbError(error))');
    });
  }
  it('every form submit guards its write', () => {
    const forms = bodies('onSubmit');
    expect(forms.length).toBe(4);
    for (const b of forms) {
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toContain('toastError(describeDbError(error))');
    }
  });
  it('a move updates the item first and reports a failed history insert', () => {
    const move = bodies('onSubmit').find((b) => b.includes("from('inventory_moves').insert("))!;
    expect(move.indexOf("from('inventory_items').update(")).toBeLessThan(move.indexOf("from('inventory_moves').insert("));
    expect(move).toContain('if (moveError) return toastError(describeDbError(moveError));');
  });
  it('photo uploads surface storage errors', () => {
    const b = body('uploadPhoto');
    expect(b).toContain('const { data: stored, error: upErr } =');
    expect(b).toContain('toastError(describeDbError(upErr))');
  });
});
