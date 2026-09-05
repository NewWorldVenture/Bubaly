import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/watchlist-module.tsx', 'utf8');
function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('watchlist-module writes fail visibly', () => {
  for (const fn of ['castVote', 'setStatus', 'deleteTitle', 'deleteSession', 'onSubmit']) {
    it(`${fn} guards its Supabase result`, () => {
      const b = body(fn);
      expect(b).toMatch(/const \{ error \} =/);
      expect(b).toMatch(/toastError\(describeDbError\(error\)\)/);
    });
  }
  it('logging a movie night also reports a failed status flip', () => {
    expect(src).toContain("const { error: statusError } = await supabase.from('watchlist_titles').update({ status: 'watched' })");
    expect(src).toContain('if (statusError) return toastError(describeDbError(statusError));');
  });
  it('votes are one row per member per title (toggle off = delete, change = update)', () => {
    const b = body('castVote');
    expect(b).toContain("from('watchlist_votes').delete()");
    expect(b).toContain("from('watchlist_votes').update({ vote })");
    expect(b).toContain("from('watchlist_votes').insert(");
  });
});
