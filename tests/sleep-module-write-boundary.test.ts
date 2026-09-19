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
      // `{ data, error }` counts. A delete on an RLS-gated table has to ask
      // PostgREST which rows it touched — `.select('id')` — because the policy
      // FILTERS the write rather than refusing it, so `error` alone cannot tell
      // "removed" from "not yours to remove". Pinning the exact destructuring
      // spelling made this fail on a change that strengthened the very thing it
      // asks about. See tests/a-filtered-delete-is-not-a-deletion.test.ts.
      expect(b).toMatch(/const \{ (data, )?error \} =/);
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
    expect(src).toContain("if (duration === 0) return toastError(t('sleepModule.wakeTimeMustBeAfter'));");
  });
});
