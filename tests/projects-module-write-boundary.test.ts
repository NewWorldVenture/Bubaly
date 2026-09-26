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
      // Re-pointed under C1-S9-79 from the exact `const { error } =`: each
      // write now also binds the rows it changed (`{ data: moved, error }`).
      // The property is unchanged — the error is bound and surfaced.
      expect(b, fn).toMatch(/const \{ (?:data(?:: \w+)?, )?error \} =/);
      expect(b, fn).toContain('toastError(describeDbError(error))');
    }
  });
  it('all three forms guard their insert/update', () => {
    const forms = bodies('onSubmit');
    expect(forms).toHaveLength(3);
    for (const b of forms) {
      expect(b).toMatch(/const \{ (?:data(?:: \w+)?, )?error \} =/);
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
    // Re-pointed under C1-S9-79. The old pin was the defect itself: a failed
    // link toasted its error and then fell through to "Accepted …". It now
    // returns, and only a link that landed is followed by the success.
    expect(b).toContain('if (linkError) return toastError(describeDbError(linkError))');
  });
  it('deleting a project is confirmed and the suggester never inserts an empty batch', () => {
    expect(bodies('deleteProject')[0]).toMatch(/if \(!confirm\(/);
    expect(bodies('suggestMaterials')[0]).toMatch(/if \(!fresh\.length\) return toastError\(/);
  });
});
