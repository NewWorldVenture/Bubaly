import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/moving-module.tsx', 'utf8');
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

describe('moving-module writes fail visibly', () => {
  it('every inline mutation guards its result', () => {
    for (const fn of ['generateTasks', 'setTaskStatus', 'deleteTask', 'advanceBox', 'deleteBox', 'setMoveStatus', 'deleteMove']) {
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
  it('a duplicate box number is explained, not swallowed', () => {
    const [boxForm] = bodies('onSubmit').filter((b) => b.includes("from('move_boxes')"));
    expect(boxForm).toContain("error.code === '23505'");
  });
  it('the checklist generator never inserts an empty batch and deleting a move is confirmed', () => {
    const [gen] = bodies('generateTasks');
    expect(gen).toMatch(/if \(!plan\.length\) return toastError\(/);
    const [del] = bodies('deleteMove');
    expect(del).toMatch(/if \(!confirm\(/);
  });
});
