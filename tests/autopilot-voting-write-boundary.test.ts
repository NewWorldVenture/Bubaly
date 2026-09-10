import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Autopilot failure/order coverage now runs the actual service and component in
// autopilot-resolution.test.ts and autopilot-resolution-ui.test.ts. These voting
// assertions remain unchanged until that write path receives runtime coverage.
function body(src: string, fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('voting vote clear/un-vote deletes fail visibly', () => {
  const b = body(readFileSync('components/modules/voting-module.tsx', 'utf8'), 'vote');

  it('the un-vote delete surfaces its error', () => {
    expect(b).toContain('const { error: unErr } = await supabase.from');
    expect(b).toContain('if (unErr) toastError(describeDbError(unErr))');
  });

  it('the single-choice clear returns before inserting when the clear fails', () => {
    const clear = b.indexOf('const { error: clearErr } = await supabase.from');
    const clearGuard = b.indexOf('if (clearErr) return toastError');
    const insert = b.indexOf(".insert({ family_id: familyId, poll_id");
    expect(clear).toBeGreaterThan(-1);
    expect(clearGuard).toBeGreaterThan(clear);
    expect(insert).toBeGreaterThan(clearGuard);
  });
});
