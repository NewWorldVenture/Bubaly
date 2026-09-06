// One door into `todo_items` FROM THIS MODULE, and an honest account of what is
// outside it.
//
// The companion to `todo-write-path.test.ts`: that file proves the actions are
// right, this one proves the module calls them. A client component with hooks
// does not render under `environment: 'node'`, and a passing action is exactly
// what a module still writing straight to PostgREST would leave behind.
//
// SCOPE, stated because getting it wrong cost a real bug: this file reads ONE
// module and can only ever speak for that module. It passed while
// `next-actions-module.tsx` updated `todo_items` directly, filtering `id` alone,
// and the tranche report said the table was at zero browser writes on the
// strength of it. The per-TABLE claim lives in `tests/service-layer-forks.test.ts`,
// which sweeps every component in the repo.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MODULE = 'components/modules/todos-module.tsx';

/** Every write verb reachable from `.from('todo_items')`. */
const ITEM_WRITE = /\.from\(\s*['"]todo_items['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\s*\(/g;

/** Comments out, code in — a file explaining what it no longer does will name it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
}

describe('the to-do surface writes through the service', () => {
  it('issues no direct write to todo_items', () => {
    expect([...code(MODULE).matchAll(ITEM_WRITE)].map((m) => m[1])).toEqual([]);
  });

  it('still reads todo_items directly, which is not what §7 is about', () => {
    // The guard is deliberately about WRITES. A client read is the normal pattern
    // in this app, and asserting otherwise would fail for the wrong reason.
    expect(code(MODULE)).toMatch(/\.from\('todo_items'\)\s*\.select\(/);
  });

  it('reaches the list through the server actions instead', () => {
    expect(code(MODULE)).toMatch(/from '@\/app\/\(app\)\/dashboard\/todos\/actions'/);
  });

  it('mints a submission id for every create it makes', () => {
    // A create with no id degrades to today's un-deduplicated write — the right
    // failure mode, but the wrong default: a call site that forgets the id
    // reopens the gap silently, with every other test still green.
    const src = code(MODULE);
    const creates = (src.match(/createTodoAction\(/g) ?? []).length;
    expect(creates).toBeGreaterThan(0);
    expect(src).toMatch(/from '@\/lib\/utils\/submission-id'/);
    expect((src.match(/submissionId:/g) ?? []).length).toBe(creates);
  });

  it('leaves the two todo_lists writes alone, deliberately', () => {
    // A list is not an item. §7's symptoms are about the rows a family
    // accumulates duplicates of, and `ensureTodoList` exists but takes no icon
    // or colour, so routing these through it would quietly change what a new
    // list looks like. Named here so converting them is a deliberate edit.
    const listWrites = code(MODULE).match(/\.from\('todo_lists'\)[\s\S]{0,120}?\.insert\(/g) ?? [];
    expect(listWrites.length).toBe(2);
  });
});
