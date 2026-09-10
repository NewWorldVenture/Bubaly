import { describe, expect, it, vi } from 'vitest';
import { FamilySession } from '../mobile/src/lib/family-session';
import type { ActiveFamily } from '../mobile/src/lib/family';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const family: ActiveFamily = { familyId: 'family-1', memberId: 'member-1', familyName: 'First', timezone: 'UTC', role: 'parent', displayName: 'Parent' };
function setup() {
  let user: string | null = 'user-1';
  const deps = { user: () => user, read: vi.fn(async (_id: string): Promise<ActiveFamily | null> => family), result: vi.fn(), loading: vi.fn() };
  return { loader: new FamilySession(deps), deps, user: (next: string | null) => { user = next; } };
}

describe('current mobile family', () => {
  it('an older successful read cannot replace a newer selected household', async () => {
    const { loader, deps } = setup(); const old = deferred<ActiveFamily>(); deps.read.mockReturnValueOnce(old.promise);
    const first = loader.refresh(); const second = { ...family, familyId: 'family-2' }; deps.read.mockResolvedValueOnce(second);
    expect(await loader.refresh()).toEqual({ ok: true, family: second }); old.resolve(family);
    expect(await first).toEqual({ ok: false, code: 'context_changed' }); expect(deps.result.mock.calls).toEqual([[second, false]]);
    expect(deps.loading.mock.calls).toEqual([[true], [true], [false]]);
  });
  it.each(['signout', 'different-account', 'unmount'])('ignores a late family result after %s', async (reason) => {
    const { loader, deps, user } = setup(); const old = deferred<ActiveFamily>(); deps.read.mockReturnValueOnce(old.promise);
    const first = loader.refresh(); if (reason === 'signout') user(null); else if (reason === 'different-account') user('user-2'); else loader.invalidate();
    old.resolve(family); expect(await first).toEqual({ ok: false, code: 'context_changed' }); expect(deps.result).not.toHaveBeenCalled();
  });
  it('an old rejected read cannot clear the latest household or loading state', async () => {
    const { loader, deps } = setup(); const old = deferred<ActiveFamily>(); deps.read.mockReturnValueOnce(old.promise);
    const first = loader.refresh(); await loader.refresh(); old.reject(new Error('old transport'));
    expect(await first).toEqual({ ok: false, code: 'context_changed' }); expect(deps.result.mock.calls).toEqual([[family, false]]);
  });
  it('clears stale family data and returns unavailable when the current read fails; retry recovers', async () => {
    const { loader, deps } = setup(); const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    deps.read.mockRejectedValueOnce(new Error('membership query unavailable'));
    expect(await loader.refresh()).toEqual({ ok: false, code: 'unavailable' }); expect(deps.result).toHaveBeenLastCalledWith(null, true);
    expect(deps.loading).toHaveBeenLastCalledWith(false); expect(log).toHaveBeenCalled();
    expect(await loader.refresh()).toEqual({ ok: true, family }); expect(deps.result).toHaveBeenLastCalledWith(family, false); log.mockRestore();
  });
  it('does not read a family for a signed-out account', async () => {
    const { loader, deps, user } = setup(); user(null);
    expect(await loader.refresh()).toEqual({ ok: false, code: 'context_changed' }); expect(deps.read).not.toHaveBeenCalled();
  });
});
