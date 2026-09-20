import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { between } from './helpers/source-order';

/**
 * Audit C1-S9-11 — a REFUTATION, pinned so it cannot be "fixed" back into a bug.
 *
 * Claude-2 recorded `components/capture/document-capture.tsx:24` as "a genuine
 * ref-in-cleanup bug" on the strength of the react-hooks/exhaustive-deps
 * warning there, and proposed the rule's standard remedy: copy
 * `generation.current` to a variable inside the effect and use that variable in
 * the cleanup.
 *
 * That remedy would introduce the bug it describes. The warning exists for a
 * cleanup that READS a ref expecting the value it had at effect time — usually a
 * DOM node that React has since detached. This cleanup WRITES: `generation.current++`
 * is a monotonic invalidation counter, and incrementing it at cleanup time is
 * exactly the intent. Capturing the value first and writing `captured + 1` back
 * would RESET the counter to a stale number, so an in-flight `save()` that took
 * a higher `current` would pass its own `isCurrent()` check and commit a result
 * belonging to a previous family or user — which is the use-after-invalidate the
 * counter exists to prevent.
 *
 * The invariant is therefore: this counter is only ever incremented, never read
 * into a local and written back, and `save()` compares against the value it took.
 */
const source = readFileSync('components/capture/document-capture.tsx', 'utf8');

describe('the capture generation counter only ever goes up (C1-S9-11)', () => {
  it('increments in the effect body and again in its cleanup', () => {
    const effect = between(source, 'useEffect(() => {', '}, [familyId, userId]);');
    expect(effect).toContain('generation.current++;');
    expect(effect).toContain('return () => { generation.current++; };');
  });

  it('never assigns the counter from a captured local', () => {
    // `generation.current = <anything but ++>` is the shape the proposed
    // "fix" would produce, and the shape that breaks the invariant.
    const assignments = source.match(/generation\.current\s*=[^=]/g) ?? [];
    expect(assignments, 'the counter must only be incremented, never assigned').toEqual([]);
    // The only two ways it may change.
    const mutations = source.match(/generation\.current(\+\+|\s*=[^=])/g) ?? [];
    expect(mutations.every((m) => m.endsWith('++'))).toBe(true);
    // And `++generation.current` in save(), which takes the new value.
    expect(source).toContain('const current = ++generation.current;');
  });

  it('save() abandons its result when the counter moved underneath it', () => {
    const save = between(source, 'async function save()', 'const failed =');
    // Checked both before the await (via isCurrent, inside the upload) and
    // after it, because either side can be the one that moves.
    expect(save).toContain('isCurrent: () => generation.current === current');
    expect(save).toContain('if (generation.current !== current) return;');
    // The bail must precede the state write it is protecting.
    expect(between(save, 'if (generation.current !== current) return;', 'setResult(response);')).toBeTruthy();
  });
});
