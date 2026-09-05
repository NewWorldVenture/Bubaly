import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/language-module.tsx', 'utf8');
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

describe('language-module writes fail visibly', () => {
  it('every inline mutation guards its result', () => {
    for (const fn of ['gradeCard', 'finishReview', 'toggleSuspend', 'deleteCard', 'addStarterDeck', 'deleteSession', 'archiveGoal', 'deleteGoal']) {
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
  it('grading a card persists the SM-2 result and the starter deck never inserts an empty batch', () => {
    expect(bodies('gradeCard')[0]).toContain('const next = sm2(c, grade, new Date())');
    expect(bodies('gradeCard')[0]).toContain(".update(next).eq('id', c.id)");
    expect(bodies('addStarterDeck')[0]).toMatch(/if \(!fresh\.length\) return toastError\(/);
  });
  it('a new goal seeds its starter deck and reports a failed deck insert without losing the goal', () => {
    const [form] = bodies('onSubmit').filter((b) => b.includes("from('language_goals')"));
    expect(form).toContain('const { error: deckError } =');
    expect(form).toContain('if (deckError) toastError(describeDbError(deckError))');
    expect(form).toContain('The target level must be above the current level');
  });
  it('deleting a goal is confirmed', () => {
    expect(bodies('deleteGoal')[0]).toMatch(/if \(!confirm\(/);
  });
});
