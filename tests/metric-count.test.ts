// The error-aware count helper. The whole point of `lib/metric/count.ts` is
// that "nothing" and "the database did not answer" stop being the same value,
// so these tests pin the distinction rather than the arithmetic.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { countOrNull, isCounted, pctOrNull, ratioOrNull, sumCounts } from '@/lib/metric/count';

const ok = (count: number | null) => Promise.resolve({ count, error: null });
const broken = () => Promise.resolve({ count: null, error: { message: 'permission denied for table x' } });

afterEach(() => { vi.restoreAllMocks(); });

describe('countOrNull', () => {
  it('returns the count when the read succeeds', async () => {
    await expect(countOrNull(ok(7))).resolves.toBe(7);
  });

  it('preserves an explicit exact zero', async () => {
    await expect(countOrNull(ok(0))).resolves.toBe(0);
  });

  it.each([null, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('does not invent a count from %s', async (count) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(countOrNull(ok(count), 'handled runs')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith('[metric] handled runs read failed: exact count missing or invalid');
  });

  it('returns unavailable and logs a rejected transport read', async () => {
    const error = new Error('connection reset');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(countOrNull(Promise.reject(error), 'handled runs')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith('[metric] handled runs read failed', error);
  });

  it('returns null on a read error — never 0 — and logs it under [metric]', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(countOrNull(broken(), 'handled runs')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const [message] = spy.mock.calls[0];
    expect(message).toContain('[metric]');
    expect(message).toContain('handled runs');
    expect(message).toContain('read failed');
  });

  it('does not log when the read succeeded', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await countOrNull(ok(3));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('isCounted', () => {
  it('separates a number from an unavailable count', () => {
    expect(isCounted(0)).toBe(true);
    expect(isCounted(12)).toBe(true);
    expect(isCounted(null)).toBe(false);
  });
});

describe('sumCounts', () => {
  it('adds the parts', () => {
    expect(sumCounts([1, 2, 3])).toBe(6);
    expect(sumCounts([])).toBe(0);
  });

  it('is unavailable when ANY part is unavailable', () => {
    // A sum missing one addend is not a smaller true number, it is a wrong one.
    expect(sumCounts([4, null, 2])).toBeNull();
    expect(sumCounts([null])).toBeNull();
  });
});

describe('ratioOrNull / pctOrNull', () => {
  it('divides when both sides are known', () => {
    expect(ratioOrNull(1, 4)).toBe(0.25);
    expect(pctOrNull(1, 4)).toBe(25);
  });

  it('is null when either side is unavailable', () => {
    expect(ratioOrNull(null, 4)).toBeNull();
    expect(ratioOrNull(1, null)).toBeNull();
    expect(pctOrNull(null, null)).toBeNull();
  });

  it('is null rather than 0 when the denominator is zero', () => {
    // "50% of no families" is undefined, not 0%.
    expect(ratioOrNull(0, 0)).toBeNull();
    expect(pctOrNull(3, 0)).toBeNull();
  });
});
