import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C4-S4-07.
 *
 * `/home` is the page every authenticated session lands on, and it was about
 * eleven sequential waits on the network. Four groups were collapsible with no
 * change in behaviour — the page already demonstrated the technique 120 lines
 * in (`schedulePromise` is started early and awaited later, with a comment
 * saying why), it just was not applied to the other six independent reads.
 *
 * This is a RATCHET, and its limit is worth stating: it counts top-level
 * `await`s inside `HomePage()`, which is a proxy for round-trip waves, not a
 * measurement of them. It cannot tell a slow read from a fast one, and it says
 * nothing about reads nested inside branches. What it does do is fail when
 * somebody adds a seventh sequential wait to the landing page.
 */
const source = readFileSync('app/(app)/home/page.tsx', 'utf8');
const body = source.slice(source.indexOf('export default async function HomePage'));

// Top-level statements in the function body sit at exactly two spaces.
/**
 * Every `await` in the function body, at any depth.
 *
 * Counting only TOP-LEVEL awaits was the first draft, and it could not see the
 * shape it exists to prevent: the original serial read was
 *
 *     const { data: meals } = mealIds.length
 *       ? await supabase.from('meals')…
 *
 * whose `await` sits on a continuation line, indented past any top-level
 * anchor. A total count has no such blind spot — parallelising REMOVES awaits
 * (one per group instead of one per read), so the number only goes up when
 * something is re-serialised or a new wait is added.
 */
function awaitCount(source: string): number {
  return (source.match(/\bawait /g) ?? []).length;
}

describe('the landing page does not wait on one read at a time', () => {
  it('holds at or below the collapsed wait count', () => {
    const waits = awaitCount(body);
    // 12 today. Parallelising removes awaits, so this only rises when a group
    // is pulled apart or a new sequential read is added to the landing page.
    expect(waits, `awaits in HomePage: ${waits}`).toBeLessThanOrEqual(12);
  });

  it('resolves translations once, not twice', () => {
    const calls = body.match(/await getTranslations\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('keeps the two ServiceResult loaders beside the batch, not before it', () => {
    // They stay OUTSIDE settleAll — it substitutes the { data, error } shape for
    // a rejection, which has no `ok` to branch on — but they depend on nothing
    // in it, so they go out at the same time.
    const group = body.slice(body.indexOf('await Promise.all([\n    listPending('));
    expect(group).toContain('listPending(');
    expect(group).toContain('loadCompletedByBubaly(');
    expect(group).toContain('settleAll([');
    // Each keeps its own fallback: a throw costs that list, not the batch.
    expect(group.slice(0, group.indexOf('settleAll(['))).toContain('.catch((cause)');
  });

  it('keeps every collapsed read short-circuited on an empty id list', () => {
    // The gain is in overlapping the waits, not in issuing queries nobody
    // needs. Each conditional read still resolves locally when its list is
    // empty.
    for (const guard of ['mealIds.length', 'choreIds.length', 'activePlanIds.length', 'missingChoreIds.length']) {
      expect(body, guard).toContain(`${guard}\n      ?`);
    }
  });
});
