import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

class SessionStorageUnavailableError extends Error {
  constructor() {
    super('Synthetic locked Keychain');
    this.name = 'SessionStorageUnavailableError';
    this.code = 'session_storage_unavailable';
  }
}
const key = 'sb-storage-fixture-auth-token';
const saved = JSON.stringify({
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600,
  user: { id: 'fixture-user', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-09T00:00:00Z' },
});
const values = new Map([[key, saved]]);
const mutations = [];
const requests = [];
let locked = true;
const storage = {
  getItem: async name => { if (locked) throw new SessionStorageUnavailableError(); return values.get(name) ?? null; },
  setItem: async (name, value) => { mutations.push(['set', name]); values.set(name, value); },
  removeItem: async name => { mutations.push(['remove', name]); values.delete(name); },
};
const client = createClient('https://storage-fixture.supabase.co', 'synthetic-anon-key', {
  global: { fetch: async (input) => {
    requests.push(String(input));
    assert.match(String(input), /\/auth\/v1\/logout\?scope=local$/);
    return new Response(null, { status: 204 });
  } },
  auth: { storage, storageKey: key, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});
const events = [];
const initial = client.auth.onAuthStateChange((event, session) => { events.push([event, session?.user.id ?? null]); });
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

try {
  await assert.rejects(client.auth.getSession(), SessionStorageUnavailableError);
  await settle();
  assert.ok(events.some(([event, user]) => event === 'INITIAL_SESSION' && user === null));
  assert.ok(events.every(([event]) => event !== 'SIGNED_OUT'));
  assert.equal(values.get(key), saved);
  assert.deepEqual(mutations, []);
  locked = false;
  assert.equal((await client.auth.getSession()).data.session?.user.id, 'fixture-user');
  assert.deepEqual(requests, []);
  assert.equal(values.get(key), saved);

  // Storage can become unavailable after initialization too. A new subscriber
  // must not crash the runtime or turn a storage failure into SIGNED_OUT.
  locked = true;
  const laterEvents = [];
  const later = client.auth.onAuthStateChange((event, session) => laterEvents.push([event, session?.user.id ?? null]));
  await assert.rejects(client.auth.getSession(), SessionStorageUnavailableError);
  await settle();
  assert.deepEqual(laterEvents, [['INITIAL_SESSION', null]]);
  assert.equal(values.get(key), saved);
  assert.deepEqual(mutations, []);
  later.data.subscription.unsubscribe();
  locked = false;
  assert.equal((await client.auth.getSession()).data.session?.refresh_token, 'synthetic-refresh');

  const signout = await client.auth.signOut({ scope: 'local' });
  assert.equal(signout.error, null);
  assert.equal(values.has(key), false);
  assert.ok(events.some(([event]) => event === 'SIGNED_OUT'));
  assert.equal((await client.auth.getSession()).data.session, null);
  const missingEvents = [];
  const missing = client.auth.onAuthStateChange((event, session) => missingEvents.push([event, session]));
  await settle();
  assert.deepEqual(missingEvents, [['INITIAL_SESSION', null]]);
  missing.data.subscription.unsubscribe();
  assert.equal(requests.length, 1);
  console.log('cold recovery, later subscription, missing session and explicit sign-out passed');
} finally {
  initial.data.subscription.unsubscribe();
  await client.auth.stopAutoRefresh();
}
