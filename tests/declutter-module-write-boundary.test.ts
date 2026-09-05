import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/declutter-module.tsx', 'utf8');
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

describe('declutter-module writes fail visibly', () => {
  it('every inline mutation guards its result', () => {
    for (const fn of ['planWeek', 'skipMission', 'reopenMission', 'deleteMission', 'resetZone', 'bumpScore', 'archiveZone']) {
      const [b] = bodies(fn);
      expect(b, fn).toBeTruthy();
      expect(b, fn).toMatch(/const \{ error \} =/);
      expect(b, fn).toContain('toastError(describeDbError(error))');
    }
  });
  it('all four forms guard their insert/update', () => {
    const forms = bodies('onSubmit');
    expect(forms).toHaveLength(4);
    for (const b of forms) {
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toContain('toastError(describeDbError(error))');
    }
  });
  it('finishing a mission also reports a failed session insert', () => {
    const [complete] = bodies('onSubmit').filter((b) => b.includes("status: 'done'"));
    expect(complete).toBeTruthy();
    expect(complete).toContain('const { error: sessionError } =');
    expect(complete).toContain('if (sessionError) toastError(describeDbError(sessionError))');
  });
  it('the weekly planner never inserts an empty batch', () => {
    const [b] = bodies('planWeek');
    expect(b).toMatch(/if \(!plan\.length\) return toastError\(/);
  });
});
