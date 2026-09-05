// Supabase sessions (~3–4 KB of JSON) exceed the 2 KB per-item guidance of the
// iOS Keychain / Android Keystore behind expo-secure-store. Rather than fall
// back to plaintext AsyncStorage, this adapter transparently splits large
// values into chunks so the session stays in secure storage.
//
// Layout: `<key>` holds either the plain value (small) or a header `chunks:N`;
// chunk i lives at `<key>.<i>`. Pure TypeScript — unit-tested from the root.

export const SECURE_CHUNK_SIZE = 1800;
const HEADER_PREFIX = 'chunks:';

export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

export function splitChunks(value: string, size = SECURE_CHUNK_SIZE): string[] {
  if (!value) return [''];
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

function parseHeader(raw: string | null): number | null {
  if (!raw || !raw.startsWith(HEADER_PREFIX)) return null;
  const n = Number(raw.slice(HEADER_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

export function createChunkedStore(backing: KeyValueStore, size = SECURE_CHUNK_SIZE): KeyValueStore {
  return {
    async getItem(key) {
      const raw = await backing.getItem(key);
      const count = parseHeader(raw);
      if (count === null) return raw;
      const parts = await Promise.all(range(count).map((i) => backing.getItem(chunkKey(key, i))));
      // A torn write (missing chunk) must read as "no session", never as garbage.
      if (parts.some((p) => p === null)) return null;
      return parts.join('');
    },
    async setItem(key, value) {
      const previous = parseHeader(await backing.getItem(key)) ?? 0;
      if (value.length <= size) {
        await backing.setItem(key, value);
        await Promise.all(range(previous).map((i) => backing.removeItem(chunkKey(key, i))));
        return;
      }
      const chunks = splitChunks(value, size);
      await Promise.all(chunks.map((chunk, i) => backing.setItem(chunkKey(key, i), chunk)));
      await backing.setItem(key, `${HEADER_PREFIX}${chunks.length}`);
      await Promise.all(range(previous - chunks.length).map((i) => backing.removeItem(chunkKey(key, chunks.length + i))));
    },
    async removeItem(key) {
      const previous = parseHeader(await backing.getItem(key)) ?? 0;
      await Promise.all(range(previous).map((i) => backing.removeItem(chunkKey(key, i))));
      await backing.removeItem(key);
    },
  };
}
