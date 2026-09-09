import { describe, expect, it, vi } from 'vitest';
import { AuthClient } from '@supabase/supabase-js';
import { createChunkedStore, splitChunks, SessionStorageUnavailableError, type KeyValueStore } from '@/mobile/src/lib/chunked-storage';
import { isRetryableAuthError } from '@/mobile/src/lib/auth-core';
import { isRetryableAuthError as webRetryable } from '@/lib/auth/session';

function fixture(size = 10) {
  const map = new Map<string, string>();
  const backing: KeyValueStore = {
    getItem: vi.fn(async (key) => map.get(key) ?? null),
    setItem: vi.fn(async (key, value) => { map.set(key, value); }),
    removeItem: vi.fn(async (key) => { map.delete(key); }),
  };
  return { map, backing, store: createChunkedStore(backing, size) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('durable mobile secure storage', () => {
  it('reads legacy sessions and migrates them only after a successful refresh write', async () => {
    const f = fixture();
    f.map.set('session', 'chunks:2'); f.map.set('session.0', 'old-token-'); f.map.set('session.1', 'end');
    expect(await f.store.getItem('session')).toBe('old-token-end');
    await f.store.setItem('session', 'new-session-value');
    expect(await createChunkedStore(f.backing, 10).getItem('session')).toBe('new-session-value');
    expect(f.map.has('session.0')).toBe(false); expect(f.map.has('session.1')).toBe(false);
  });

  it.each(['chunks', 'commit'])('preserves the previous session when the %s write fails', async phase => {
    const f = fixture();
    await f.store.setItem('session', 'old-session-value');
    const before = new Map(f.map);
    let count = 0;
    vi.mocked(f.backing.setItem).mockImplementation(async (key, value) => {
      if ((phase === 'chunks' && ++count === 2) || (phase === 'commit' && key === 'session')) throw new Error('native write failed');
      f.map.set(key, value);
    });
    await expect(f.store.setItem('session', 'new-session-value-long')).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    expect(f.map).toEqual(before);
    expect(await createChunkedStore(f.backing).getItem('session')).toBe('old-session-value');
    vi.mocked(f.backing.setItem).mockImplementation(async (key, value) => { f.map.set(key, value); });
    await f.store.setItem('session', 'successful-retry');
    expect(await f.store.getItem('session')).toBe('successful-retry');
  });

  it('keeps committed chunks when native storage rejects after committing the header', async () => {
    const f = fixture();
    await f.store.setItem('session', 'old-session-value');
    vi.mocked(f.backing.setItem).mockImplementation(async (key, value) => {
      f.map.set(key, value);
      if (key === 'session') throw new Error('ambiguous native result');
    });
    await f.store.setItem('session', 'new-session-value');
    expect(await f.store.getItem('session')).toBe('new-session-value');
  });

  it('leaves an ambiguous committed generation intact when its confirmation read also fails', async () => {
    const f = fixture();
    await f.store.setItem('session', 'old-session-value');
    let committed = false;
    vi.mocked(f.backing.setItem).mockImplementation(async (key, value) => {
      f.map.set(key, value);
      if (key === 'session') { committed = true; throw new Error('ambiguous native result'); }
    });
    vi.mocked(f.backing.getItem).mockImplementation(async key => {
      if (committed) throw new Error('storage inaccessible');
      return f.map.get(key) ?? null;
    });
    await expect(f.store.setItem('session', 'new-session-value')).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    committed = false;
    expect(await f.store.getItem('session')).toBe('new-session-value');
  });

  it('continues to read the committed session when obsolete encrypted chunks cannot be cleaned', async () => {
    const f = fixture();
    await f.store.setItem('session', 'old-session-value');
    vi.mocked(f.backing.removeItem).mockRejectedValue(new Error('cleanup failed'));
    await f.store.setItem('session', 'new-session-value');
    expect(await f.store.getItem('session')).toBe('new-session-value');
  });

  it('serializes read and explicit sign-out behind an in-flight refresh across adapters', async () => {
    const f = fixture();
    const other = createChunkedStore(f.backing, 10);
    await f.store.setItem('session', 'old-session-value');
    const entered = deferred(); const release = deferred();
    let first = true;
    vi.mocked(f.backing.setItem).mockImplementation(async (key, value) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      f.map.set(key, value);
    });
    const writing = f.store.setItem('session', 'new-session-value');
    await entered.promise;
    const reading = other.getItem('session');
    const signingOut = other.removeItem('session');
    release.resolve();
    await writing;
    expect(await reading).toBe('new-session-value');
    await signingOut;
    expect(await f.store.getItem('session')).toBeNull();
    expect(f.map.size).toBe(0);
  });

  it('cannot revive a signed-out session if deleting obsolete chunks fails', async () => {
    const f = fixture(); await f.store.setItem('session', 'old-session-value');
    vi.mocked(f.backing.removeItem).mockImplementation(async key => {
      if (key !== 'session') throw new Error('cleanup failed');
      f.map.delete(key);
    });
    await f.store.removeItem('session');
    expect(await createChunkedStore(f.backing).getItem('session')).toBeNull();
  });

  it('does not report a successful sign-out when removing the committed header fails', async () => {
    const f = fixture(); await f.store.setItem('session', 'old-session-value');
    vi.mocked(f.backing.removeItem).mockRejectedValue(new Error('keychain locked'));
    await expect(f.store.removeItem('session')).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    expect(await f.store.getItem('session')).toBe('old-session-value');
  });

  it.each(['chunks:0', 'chunks:nope', 'chunks:99999999', 'chunks-v2:bad:0'])('allows explicit new sign-in or sign-out after damaged header %s', async header => {
    const f = fixture(); f.map.set('session', header);
    await expect(f.store.getItem('session')).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    await f.store.setItem('session', 'fresh-login');
    expect(await f.store.getItem('session')).toBe('fresh-login');
    f.map.set('session', header);
    await f.store.removeItem('session');
    expect(await f.store.getItem('session')).toBeNull();
  });

  it('does not overwrite a previous session when storage cannot be read', async () => {
    const f = fixture(); await f.store.setItem('session', 'old-session-value');
    const before = new Map(f.map);
    vi.mocked(f.backing.getItem).mockRejectedValue(new Error('keychain locked'));
    await expect(f.store.setItem('session', 'new-session-value')).rejects.toBeInstanceOf(SessionStorageUnavailableError);
    expect(f.map).toEqual(before);
  });

  it('treats unavailable Keychain reads as restoring on mobile and web, not missing auth', async () => {
    const f = fixture(); vi.mocked(f.backing.getItem).mockRejectedValue(new Error('keychain locked'));
    const error = await f.store.getItem('session').catch(error => error);
    expect(isRetryableAuthError(error)).toBe(true);
    expect(webRetryable(error)).toBe(true);
    expect(isRetryableAuthError({ code: 'refresh_token_not_found', status: 400 })).toBe(false);
  });

  it('retries a concurrent pointer change instead of returning mixed or signed-out data', async () => {
    const f = fixture(); await f.store.setItem('session', 'old-session-value');
    let firstPart = true;
    vi.mocked(f.backing.getItem).mockImplementation(async key => {
      if (key !== 'session' && firstPart) { firstPart = false; f.map.set('session', 'current'); }
      return f.map.get(key) ?? null;
    });
    expect(await f.store.getItem('session')).toBe('current');
  });

  it('bounds UTF-8 bytes without splitting characters and reads marker-looking plain values', async () => {
    const text = 'é漢🙂'.repeat(1000);
    const parts = splitChunks(text, 10);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => Buffer.byteLength(part, 'utf8') <= 10)).toBe(true);
    expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part))).toBe(true);
    const f = fixture();
    for (const value of ['chunks:2', 'chunks-v2:example:2', '']) {
      await f.store.setItem('session', value);
      expect(await f.store.getItem('session')).toBe(value);
    }
  });

  it('restores the actual AuthClient after a locked Keychain without asking for credentials again', async () => {
    const f = fixture(1800);
    const key = 'sb-storage-test-auth-token';
    const session = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'stored-user' } };
    await f.store.setItem(key, JSON.stringify(session));
    let locked = true;
    vi.mocked(f.backing.getItem).mockImplementation(async name => {
      if (locked) throw new Error('keychain locked');
      return f.map.get(name) ?? null;
    });
    const fetcher = vi.fn<typeof fetch>();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = new AuthClient({
      url: 'https://storage-test.supabase.co/auth/v1', fetch: fetcher,
      storage: f.store, storageKey: key, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    });
    try {
      await expect(auth.getSession()).rejects.toBeInstanceOf(SessionStorageUnavailableError);
      locked = false;
      expect((await auth.getSession()).data.session?.refresh_token).toBe('synthetic-refresh');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await f.store.getItem(key)).toBe(JSON.stringify(session));
    } finally { await auth.stopAutoRefresh(); log.mockRestore(); }
  });
});
