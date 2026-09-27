import { describe, expect, it } from 'vitest';
import { bumpWearCount, WEAR_BUMP_ATTEMPTS, type WearStore } from '@/lib/closet/wear';

/**
 * Audit C1-S9-90 — the closet wear-count lost update.
 *
 * The module wrote `cached + 1`. Two members logging an outfit that shares an
 * item each wrote the same number, and one wear vanished. The bump is now a
 * compare-and-swap on the live count; these drive it against a store that
 * behaves like PostgREST (a filtered UPDATE that matches nothing answers `[]`),
 * with a second writer landing between one side's read and its write.
 */
function store(initial: number, opts: { interleave?: (s: { count: number }) => void; readError?: unknown; missing?: boolean } = {}) {
  const state = { count: initial, writes: 0, reads: 0 };
  let interleaved = false;
  const s: WearStore = {
    async readWearCount() {
      state.reads++;
      if (opts.readError) return { data: null, error: opts.readError };
      if (opts.missing) return { data: null, error: null };
      return { data: { wear_count: state.count }, error: null };
    },
    async writeWearCount(_id, expected, next) {
      // The other writer lands after our read, once.
      if (opts.interleave && !interleaved) { interleaved = true; opts.interleave(state); }
      state.writes++;
      if (state.count !== expected) return { data: [], error: null };
      state.count = next;
      return { data: [{ id: 'item-1' }], error: null };
    },
  };
  return { s, state };
}

describe('a worn outfit adds exactly one wear per item', () => {
  it('two writers racing both count', async () => {
    // The other member's bump lands between our read (5) and our write.
    const { s, state } = store(5, { interleave: (st) => { st.count += 1; } });
    const result = await bumpWearCount(s, 'item-1', '2026-09-27');
    expect(result).toEqual({ ok: true });
    // `cached + 1` would leave 6: one wear lost. Both wears are here.
    expect(state.count).toBe(7);
    expect(state.reads).toBe(2);
  });

  it('an uncontended bump is one read and one write (not over-built)', async () => {
    const { s, state } = store(0);
    expect(await bumpWearCount(s, 'item-1', '2026-09-27')).toEqual({ ok: true });
    expect(state).toMatchObject({ count: 1, reads: 1, writes: 1 });
  });

  it('a failed read writes nothing and says so', async () => {
    const { s, state } = store(3, { readError: { message: 'timeout' } });
    const result = await bumpWearCount(s, 'item-1', '2026-09-27');
    expect(result.ok).toBe(false);
    expect(state.writes).toBe(0);
    expect(state.count).toBe(3);
  });

  it('an item that is gone is not reported as worn', async () => {
    const { s } = store(3, { missing: true });
    expect(await bumpWearCount(s, 'item-1', '2026-09-27')).toEqual({ ok: false, reason: 'missing' });
  });

  it('gives up, and says so, if the count never holds still', async () => {
    const state = { count: 0 };
    const s: WearStore = {
      async readWearCount() { return { data: { wear_count: state.count }, error: null }; },
      async writeWearCount() { state.count += 1; return { data: [], error: null }; },
    };
    expect(await bumpWearCount(s, 'item-1', '2026-09-27')).toEqual({ ok: false, reason: 'contended' });
    expect(state.count).toBe(WEAR_BUMP_ATTEMPTS);
  });
});
