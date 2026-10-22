/** Password producer admission only. This record is never an auth/cache grant.
 * Ordinary HTTP/SSR writers do not yet participate in this bounded lane. */
type RecordValue = { v: 1; revision: number; nonce: string; phase: 'pending' | 'used' };
export type PasswordOriginAdmission = {
  nonce: string;
  commit: (isCurrent: () => boolean, write: () => void) => Promise<boolean>;
};
const dbName = 'bubaly-password-operation-v1';
const valid = (value: unknown): value is RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join('|') === 'nonce|phase|revision|v' && row.v === 1
    && Number.isSafeInteger(row.revision) && (row.revision as number) > 0
    && typeof row.nonce === 'string' && /^[a-f0-9]{32}$/.test(row.nonce)
    && (row.phase === 'pending' || row.phase === 'used');
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function locked<T>(name: string, run: (alive: () => boolean) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { active = false; controller.abort(); reject(new Error('Password admission deadline')); }, 5_000);
  });
  try {
    return await Promise.race([navigator.locks.request(name, { mode: 'exclusive', signal: controller.signal }, () => run(() => active)), deadline]);
  } finally { active = false; if (timer) clearTimeout(timer); }
}
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('operations'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Password admission storage blocked'));
  });
}
async function read(key: string): Promise<RecordValue | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly');
      const request = tx.objectStore('operations').get(key);
      request.onsuccess = () => {
        if (request.result === undefined) resolve(null);
        else if (valid(request.result)) resolve(request.result);
        else reject(new Error('Malformed password admission record'));
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function cas(key: string, previous: RecordValue | null, next: RecordValue): Promise<boolean> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite', { durability: 'strict' });
      if (tx.durability !== 'strict') { tx.abort(); reject(new Error('Strict password admission durability unavailable')); return; }
      const store = tx.objectStore('operations'), request = store.get(key);
      let changed = false;
      request.onsuccess = () => {
        const current: unknown = request.result === undefined ? null : request.result;
        if (current !== null && !valid(current)) { tx.abort(); return; }
        if (equal(current, previous)) { store.put(next, key); changed = true; }
      };
      tx.oncomplete = () => resolve(changed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Password admission CAS aborted'));
    });
  } finally { db.close(); }
}
export async function admitPasswordOperation(storageKey: string, isCurrent: () => boolean): Promise<PasswordOriginAdmission> {
  if (!/^sb-[A-Za-z0-9_-]+-auth-token$/.test(storageKey) || !navigator.locks) throw new Error('Password admission capability unavailable');
  const lock = 'bubaly:password-operation:' + storageKey;
  const pending = await locked(lock, async alive => {
    if (!alive() || !isCurrent()) throw new Error('Password decision changed before admission');
    const previous = await read(storageKey);
    if (previous && previous.revision === Number.MAX_SAFE_INTEGER) throw new Error('Password revision exhausted');
    const next: RecordValue = { v: 1, revision: (previous?.revision ?? 0) + 1,
      nonce: [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''), phase: 'pending' };
    if (!alive() || !isCurrent() || !await cas(storageKey, previous, next) || !alive() || !isCurrent()) throw new Error('Password admission refused');
    return next;
  });
  let used = false;
  return {
    nonce: pending.nonce,
    commit: async (stillCurrent, write) => locked(lock, async alive => {
      if (used || !alive() || !stillCurrent()) return false;
      const current = await read(storageKey);
      if (!equal(current, pending) || !alive() || !stillCurrent()) return false;
      // Consume this one operation before the synchronous cookie projection.
      // A failure/crash cannot authorize a second commit of its provider result.
      if (!await cas(storageKey, pending, { ...pending, phase: 'used' }) || !alive() || !stillCurrent()) return false;
      used = true;
      write();
      return true;
    }),
  };
}
