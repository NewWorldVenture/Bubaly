import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/sleep-module.tsx', 'utf8');
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

describe('sleep-module writes fail visibly', () => {
  it('deleteLog and archiveRoutine guard their results', () => {
    for (const fn of ['deleteLog', 'archiveRoutine']) {
      const [b] = bodies(fn);
      expect(b, fn).toBeTruthy();
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toContain('toastError(describeDbError(error))');
    }
  });
  it('all three forms guard their upsert/insert', () => {
    const forms = bodies('onSubmit');
    expect(forms).toHaveLength(3);
    for (const b of forms) {
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toContain('toastError(describeDbError(error))');
    }
  });
  it('nights and check-ins are one row per member per day (upsert on the unique key)', () => {
    expect(src).toContain("{ onConflict: 'member_id,sleep_date' }");
    expect(src).toContain("{ onConflict: 'member_id,checkin_date' }");
  });
  it('refuses a night whose wake time is not after bedtime', () => {
    expect(src).toContain("if (duration === 0) return toastError('Wake time must be after bedtime');");
  });
});
