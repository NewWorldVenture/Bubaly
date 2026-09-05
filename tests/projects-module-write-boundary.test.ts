import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/projects-module.tsx', 'utf8');
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

describe('projects-module writes fail visibly', () => {
  it('every inline mutation guards its result', () => {
    for (const fn of ['setStatus', 'deleteProject', 'togglePurchased', 'deleteMaterial', 'suggestMaterials', 'setQuoteStatus', 'deleteQuote']) {
      const [b] = bodies(fn);
      expect(b, fn).toBeTruthy();
      expect(b, fn).toMatch(/const \{ error \} =/);
      expect(b, fn).toContain('toastError(describeDbError(error))');
    }
  });
  it('all three forms guard their insert/update', () => {
    const forms = bodies('onSubmit');
    expect(forms).toHaveLength(3);
    for (const b of forms) {
      expect(b).toMatch(/const \{ (data, )?error \} =/);
      expect(b).toContain('describeDbError(error)');
    }
  });
  it('the project form reports a failed starter-materials insert without losing the project', () => {
    const [form] = bodies('onSubmit').filter((b) => b.includes("from('home_projects')"));
    expect(form).toContain('const { error: matError } =');
    expect(form).toContain('if (matError) toastError(describeDbError(matError))');
  });
  it('accepting a quote demotes other accepted quotes and links the contractor, each write guarded', () => {
    const [b] = bodies('setQuoteStatus');
    expect(b).toContain("update({ status: 'declined' }).in('id'");
    expect(b).toContain('if (demoteError) return toastError(describeDbError(demoteError))');
    expect(b).toContain('if (linkError) toastError(describeDbError(linkError))');
  });
  it('deleting a project is confirmed and the suggester never inserts an empty batch', () => {
    expect(bodies('deleteProject')[0]).toMatch(/if \(!confirm\(/);
    expect(bodies('suggestMaterials')[0]).toMatch(/if \(!fresh\.length\) return toastError\(/);
  });
});
