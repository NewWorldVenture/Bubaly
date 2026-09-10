// Supabase sessions (~3–4 KB of JSON) exceed the 2 KB per-item guidance of the
// iOS Keychain / Android Keystore behind expo-secure-store. Rather than fall
// back to plaintext AsyncStorage, this adapter transparently splits large
// values into chunks so the session stays in secure storage.
//
// Each large write gets its own generation. The header commits only after all
// chunks exist, so an interrupted refresh cannot overwrite the previous session.
// Legacy `chunks:N` values remain readable. Pure TypeScript, including byte sizing.
import { AuthRetryableFetchError } from '@supabase/supabase-js';

export const SECURE_CHUNK_SIZE = 1800;
const HEADER_PREFIX = 'chunks:';
const GENERATION_PREFIX = 'chunks-v2:';
const MAX_CHUNKS = 4096;
let generationSequence = 0;
const queues = new WeakMap<KeyValueStore, Map<string, Promise<unknown>>>();
const writeStates = new WeakMap<KeyValueStore, { revisions: Map<string, number>; blocks: Map<string, number> }>();

export class SessionWriteBlockedError extends AuthRetryableFetchError {
  constructor() {
    super('Session sign-out is in progress.', 0);
    this.code = 'session_write_blocked';
  }
}

export class SessionStorageUnavailableError extends Error {
  readonly code = 'session_storage_unavailable';
  constructor() {
    super('Secure session storage is temporarily unavailable.');
    this.name = 'SessionStorageUnavailableError';
  }
}

export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

export function splitChunks(value: string, size = SECURE_CHUNK_SIZE): string[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Invalid secure storage chunk size');
  if (!value) return [''];
  const out: string[] = [];
  let chunk = ''; let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const length = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (length > size) throw new RangeError('Secure storage chunk size cannot hold a character');
    if (bytes + length > size) { out.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += length;
  }
  if (chunk) out.push(chunk);
  return out;
}

function chunkKeys(key: string, raw: string | null): string[] | null {
  if (!raw) return null;
  const legacy = /^chunks:([1-9]\d*)$/.exec(raw);
  const generation = /^chunks-v2:([a-z0-9-]+):([1-9]\d*)$/.exec(raw);
  if (!legacy && !generation) {
    if (raw.startsWith(HEADER_PREFIX) || raw.startsWith(GENERATION_PREFIX)) throw new SessionStorageUnavailableError();
    return null;
  }
  const count = Number(legacy?.[1] ?? generation![2]);
  if (!Number.isSafeInteger(count) || count > MAX_CHUNKS) throw new SessionStorageUnavailableError();
  return Array.from({ length: count }, (_, index) => legacy ? chunkKey(key, index) : `${key}.${generation![1]}.${index}`);
}

export function createChunkedStore(backing: KeyValueStore, size = SECURE_CHUNK_SIZE): KeyValueStore & {
  removeItemIf(key: string, shouldRemove: () => boolean): Promise<boolean>;
  writeRevision(key: string): number;
  blockWrites(key: string): () => void;
} {
  const pending = queues.get(backing) ?? new Map<string, Promise<unknown>>();
  queues.set(backing, pending);
  const writes = writeStates.get(backing) ?? { revisions: new Map<string, number>(), blocks: new Map<string, number>() };
  writeStates.set(backing, writes);
  function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(run).catch(() => {
      // A locked/unavailable Keychain is not an absent or rejected session.
      throw new SessionStorageUnavailableError();
    });
    pending.set(key, result);
    void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
    return result;
  }
  // Cleanup happens only after the logical commit. Failure to remove obsolete
  // encrypted chunks must not turn a successful session save into a failed one.
  const cleanup = (keys: string[]) => Promise.allSettled(keys.map(name => backing.removeItem(name)));
  const removeItemIf = (key: string, shouldRemove: () => boolean) => serialize(key, async () => {
    let previous: string[] = [];
    try { previous = chunkKeys(key, await backing.getItem(key)) ?? []; } catch { /* Still clear a damaged session explicitly. */ }
    // A newer sign-in can arrive while this deletion waits behind a save or
    // while native storage is being read. Check ownership at the commit point.
    if (!shouldRemove()) return false;
    await backing.removeItem(key);
    await cleanup(previous);
    return true;
  });
  return {
    getItem(key) {
      return serialize(key, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const raw = await backing.getItem(key);
          const names = chunkKeys(key, raw);
          if (!names) return raw;
          const parts = await Promise.all(names.map(name => backing.getItem(name)));
          // Another adapter may have committed or signed out during this read.
          if (await backing.getItem(key) !== raw) continue;
          if (parts.some(part => part === null)) throw new SessionStorageUnavailableError();
          return parts.join('');
        }
        throw new SessionStorageUnavailableError();
      });
    },
    setItem(key, value) {
      // Do not park and replay writes during explicit sign-out: a delayed old
      // refresh could overwrite a newer login after the transaction finishes.
      // The SDK returns this recognized retryable error without claiming success.
      if (writes.blocks.has(key)) return Promise.reject(new SessionWriteBlockedError());
      writes.revisions.set(key, (writes.revisions.get(key) ?? 0) + 1);
      return serialize(key, async () => {
        const raw = await backing.getItem(key);
        let previous: string[] = [];
        // A fresh sign-in can replace a damaged header, but a failed Keychain
        // read must still stop the write before anything changes.
        try { previous = chunkKeys(key, raw) ?? []; } catch { /* No valid old generation to clean. */ }
        const chunks = splitChunks(value, size);
        if (chunks.length > MAX_CHUNKS) throw new Error('Secure session value is too large');
        const chunked = chunks.length > 1 || value.startsWith(HEADER_PREFIX) || value.startsWith(GENERATION_PREFIX);
        const generation = `${Date.now().toString(36)}-${(++generationSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
        const header = chunked ? `${GENERATION_PREFIX}${generation}:${chunks.length}` : value;
        const names = chunked ? chunks.map((_, index) => `${key}.${generation}.${index}`) : [];
        try {
          for (const [index, name] of names.entries()) await backing.setItem(name, chunks[index]);
        } catch (error) {
          await cleanup(names);
          throw error;
        }
        try { await backing.setItem(key, header); }
        catch (error) {
          // A rejected native write can be ambiguous. Do not delete the new
          // generation unless it is known not to be the committed pointer.
          let committed: string | null;
          try { committed = await backing.getItem(key); } catch { throw error; }
          if (committed !== header) { await cleanup(names); throw error; }
        }
        await cleanup(previous);
      });
    },
    removeItem(key) {
      return removeItemIf(key, () => true).then(() => {});
    },
    removeItemIf,
    writeRevision: key => writes.revisions.get(key) ?? 0,
    blockWrites(key) {
      writes.blocks.set(key, (writes.blocks.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return; released = true;
        const owners = (writes.blocks.get(key) ?? 1) - 1;
        if (owners) writes.blocks.set(key, owners); else writes.blocks.delete(key);
      };
    },
  };
}
