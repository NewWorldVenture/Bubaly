import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(mobileRoot, '..');
// Read-only dependency override for a private G: worktree. CI uses its own
// mobile/npm ci install. Never silently fall back to the root web SDK.
const dependencyRoot = resolve(process.env.BUBALY_MOBILE_AUTH_TEST_DEPENDENCIES ?? join(mobileRoot, 'node_modules'));
const requireMobile = createRequire(join(dependencyRoot, '@supabase/supabase-js/package.json'));
const { createClient } = requireMobile('@supabase/supabase-js');
const ts = createRequire(join(dependencyRoot, 'typescript/package.json'))('typescript');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const patch = json(join(mobileRoot, 'scripts/auth-storage-errors.patch.json'));
const lock = json(join(mobileRoot, 'package-lock.json'));
for (const name of ['auth-js', 'supabase-js']) {
  assert.equal(json(join(dependencyRoot, '@supabase', name, 'package.json')).version, '2.115.0');
  assert.equal(lock.packages[`node_modules/@supabase/${name}`].version, '2.115.0');
}
const runtimePins = patch.files.map(entry => {
  const hash = digest(readFileSync(join(dependencyRoot, '@supabase/auth-js', entry.path)));
  assert.equal(hash, entry.afterSha256, 'Use the existing reviewed mobile storage-error patch');
  return { path: entry.path, sha256: hash };
});

// Transpile the pinned application source under test in memory. The SDK's
// event, password-login and sign-out methods are never replaced.
const allowedSources = [
  'mobile/src/lib/auth-core.ts',
  'mobile/src/lib/chunked-storage.ts',
  'mobile/src/lib/sign-out.ts',
  'shared/auth/refresh-fetch.ts',
];
const sourcePins = Object.fromEntries(allowedSources.map(path => [
  path, digest(readFileSync(join(repositoryRoot, path))),
]));
const loaded = new Map();
function appModule(relative) {
  assert(allowedSources.includes(relative), 'Unexpected application dependency');
  if (loaded.has(relative)) return loaded.get(relative);
  const filename = join(repositoryRoot, relative);
  const source = readFileSync(filename, 'utf8');
  assert.equal(digest(source), sourcePins[relative]);
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const compiledModule = { exports: {} };
  loaded.set(relative, compiledModule.exports);
  const localRequire = specifier => {
    if (specifier === '@supabase/supabase-js') return requireMobile(specifier);
    if (relative === 'mobile/src/lib/sign-out.ts' && specifier === './auth-core') {
      return appModule('mobile/src/lib/auth-core.ts');
    }
    throw new Error('Unexpected application import: ' + specifier);
  };
  new Function('require', 'module', 'exports', result.outputText)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}
const { createChunkedStore } = appModule('mobile/src/lib/chunked-storage.ts');
const { createDeviceSignOut, createDeviceSignOutFetch, sessionStorageKey } = appModule('mobile/src/lib/sign-out.ts');
const { createSessionRefreshFetch } = appModule('shared/auth/refresh-fetch.ts');

const origin = 'https://mobile-logout-fixture.supabase.co';
const key = sessionStorageKey(origin);
const users = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  a2: '11111111-1111-4111-8111-111111111111',
  ar: '11111111-1111-4111-8111-111111111111',
};
const sessions = {
  a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  a2: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ar: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const observations = [];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function session(owner, { expired = false, chunked = false } = {}) {
  const expires = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token: encoded({ alg: 'HS256', typ: 'JWT' }) + '.' + encoded({
      sub: users[owner], session_id: sessions[owner], exp: expires, role: 'authenticated', revision: owner,
    }) + '.synthetic-signature',
    refresh_token: `synthetic-refresh-${owner}`,
    token_type: 'bearer', expires_in: 3600, expires_at: expires,
    user: { id: users[owner], aud: 'authenticated', app_metadata: {}, user_metadata: chunked ? { fixture: 'x'.repeat(4096) } : {},
      created_at: '2026-10-20T00:00:00.000Z', email: `${owner}@synthetic.invalid` },
  };
}
function ownerOf(value) {
  if (!value) return null;
  return Object.entries(users).find(([, id]) => id === JSON.parse(value).user?.id)?.[0] ?? 'unknown';
}
function sessionId(value) {
  const current = typeof value === 'string' ? JSON.parse(value) : value;
  return current ? JSON.parse(Buffer.from(current.access_token.split('.')[1], 'base64url').toString()).session_id : null;
}
async function fixture(status, options = {}) {
  const values = new Map();
  const nativeEntered = deferred(), nativeRelease = deferred();
  const refreshWriteEntered = deferred(), refreshWriteRelease = deferred();
  const refreshReadEntered = deferred(), refreshReadRelease = deferred();
  const captureReadEntered = deferred(), captureReadRelease = deferred();
  const refreshSaveIssued = deferred();
  const loginIssued = deferred(), primaryRemovalIssued = deferred();
  let armed = false, removalHeld = false, refreshHeld = false, holdRead = false, readHeld = false, captureHeld = false;
  let captureEnabled = !options.manualCapture;
  let cleanupFailures = 0;
  const backing = {
    getItem: async name => {
      const value = values.get(name) ?? null;
      if (armed && captureEnabled && options.holdCaptureRead && name === key && !captureHeld) {
        captureHeld = true; captureReadEntered.resolve(); await captureReadRelease.promise;
      }
      return value;
    },
    setItem: async (name, value) => {
      if (armed && options.holdRefreshWrite && !refreshHeld && name === key
        && value.includes('synthetic-refresh-ar')) {
        refreshHeld = true; refreshWriteEntered.resolve(); await refreshWriteRelease.promise;
      }
      values.set(name, value);
    },
    removeItem: async name => {
      const selected = options.removalPhase === 'primary' ? name === key
        : options.removalPhase === 'user-cleanup' ? name === `${key}-user`
        : options.removalPhase === 'pkce-cleanup' ? name === `${key}-code-verifier`
        : options.removalPhase === 'chunk-cleanup' ? name.startsWith(`${key}.`) : false;
      if (armed && selected && !removalHeld) {
        removalHeld = true; nativeEntered.resolve(); await nativeRelease.promise;
      }
      if (armed && options.failNativeDelete && name === key) throw new Error('Synthetic native deletion failure');
      const failedCleanupKey = options.cleanupFailure?.kind === 'pkce' ? `${key}-code-verifier` : `${key}-user`;
      if (armed && options.cleanupFailure && name === failedCleanupKey) {
        cleanupFailures += 1;
        if (options.cleanupFailure.persistent || cleanupFailures === 1) throw new Error('Synthetic secondary cleanup failure');
      }
      values.delete(name);
    },
  };
  const store = createChunkedStore(backing);
  const savedA = session('a', options);
  const refreshedA = session('ar');
  await store.setItem(key, JSON.stringify(savedA));
  const logoutEntered = deferred(), logoutRelease = deferred();
  const requests = [], events = [];
  const fetcher = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.origin, origin, 'Only synthetic provider transport is admitted');
    assert.equal(init?.method, 'POST');
    if (url.pathname === '/auth/v1/logout') {
      assert.equal(url.search, '?scope=local');
      const bearer = new Headers(init.headers).get('authorization');
      const logoutOwner = [savedA.access_token, refreshedA.access_token].some(token => bearer === `Bearer ${token}`) ? 'a' : 'other';
      if (!options.observeWrongLogout) assert.equal(logoutOwner, 'a', 'A logout must never revoke a fresh B or same-user session');
      requests.push({ path: url.pathname, scope: 'local', owner: logoutOwner });
      logoutEntered.resolve();
      await logoutRelease.promise;
      return status === 204 ? new Response(null, { status }) :
        Response.json({ message: 'Synthetic provider unavailable' }, { status });
    }
    assert.equal(url.pathname, '/auth/v1/token');
    const body = JSON.parse(init.body);
    if (url.search === '?grant_type=refresh_token') {
      assert.equal(body.refresh_token, savedA.refresh_token);
      requests.push({ path: url.pathname, grant: 'refresh_token', owner: 'a' });
      if (options.holdRefreshSnapshot) holdRead = true;
      return Response.json(refreshedA);
    }
    assert.equal(url.search, '?grant_type=password');
    const next = options.login ?? 'b';
    assert.equal(body.email, `${next}@synthetic.invalid`);
    assert.equal(body.password, 'synthetic-password');
    requests.push({ path: url.pathname, grant: 'password', owner: next });
    return Response.json(session(next));
  };
  // Every storage operation forwards to the actual adapter once with unchanged
  // arguments. Native backing waits control commit boundaries; this read hook
  // can additionally delay delivery of the real SDK refresh snapshot.
  const observedStorage = {
    getItem: async name => {
      const value = await store.getItem(name);
      if (name === key && holdRead && !readHeld) {
        readHeld = true; refreshReadEntered.resolve(); await refreshReadRelease.promise;
      }
      return value;
    },
    setItem: (name, value) => {
      const writing = store.setItem(name, value);
      if (name === key && sessionId(value) === sessions[options.login ?? 'b']) loginIssued.resolve();
      if (name === key && JSON.parse(value).refresh_token === 'synthetic-refresh-ar') refreshSaveIssued.resolve();
      return writing;
    },
    removeItem: name => {
      const removing = store.removeItem(name);
      if (name === key) primaryRemovalIssued.resolve();
      return removing;
    },
  };
  const refreshFetch = createSessionRefreshFetch(origin, fetcher);
  const protectedFetch = createDeviceSignOutFetch ? createDeviceSignOutFetch(origin,
    token => store.assertSessionSignOutOwner(key, token), refreshFetch) : refreshFetch;
  const client = createClient(origin, 'synthetic-publishable-key', {
    global: { fetch: protectedFetch },
    auth: { storage: observedStorage, storageKey: key, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
  });
  await client.auth.initialize();
  const subscription = client.auth.onAuthStateChange((event, current) => {
    events.push({ event, owner: current ? Object.entries(users).find(([, id]) => id === current.user.id)?.[0] : null });
  });
  // Settle the genuine asynchronous INITIAL_SESSION subscription before the
  // controlled schedule; no synthetic SDK event or mocked auth method.
  for (let i = 0; i < 4; i++) await tick();
  assert.equal((await client.auth.getSession()).data.session?.user.id, users.a);
  armed = true;
  const signOut = createDeviceSignOut({
    ...(store.beginSessionSignOut ? { beginSessionSignOut: () => store.beginSessionSignOut(key) } : {}),
    signOut: () => client.auth.signOut({ scope: 'local' }),
    subscribe: listener => {
      const { data } = client.auth.onAuthStateChange(event => listener(event));
      return () => data.subscription.unsubscribe();
    },
    removeSession: stillCurrent => store.removeItemIf(key, stillCurrent),
    writeRevision: () => store.writeRevision(key),
    blockWrites: () => store.blockWrites(key),
  });
  return {
    client, store, signOut, logoutEntered, logoutRelease, requests, events,
    nativeEntered, nativeRelease, loginIssued, primaryRemovalIssued, refreshWriteEntered, refreshWriteRelease,
    refreshReadEntered, refreshReadRelease,
    captureReadEntered, captureReadRelease,
    refreshSaveIssued, armCapture: () => { captureEnabled = true; },
    cleanupAttempts: () => cleanupFailures,
    close: async () => {
      logoutRelease.resolve(); nativeRelease.resolve(); refreshWriteRelease.resolve(); refreshReadRelease.resolve();
      captureReadRelease.resolve();
      subscription.data.subscription.unsubscribe(); await client.auth.stopAutoRefresh();
    },
  };
}

for (const status of [204, 503]) {
  test(`healthy unchanged A local logout (${status}) clears A`, { timeout: 10_000 }, async () => {
    const f = await fixture(status);
    try {
      const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
      await f.logoutEntered.promise;
      assert.equal(ownerOf(await f.store.getItem(key)), 'a');
      f.logoutRelease.resolve();
      const result = await ending;
      const owner = ownerOf(await f.store.getItem(key));
      observations.push({ case: `healthy-${status}`, result, owner, events: f.events, requests: f.requests });
      assert.equal(result.ok, true);
      assert.equal(owner, null);
      assert.equal((await f.client.auth.getSession()).data.session, null);
      assert(f.events.some(entry => entry.event === 'SIGNED_OUT'));
      assert.deepEqual(f.requests, [{ path: '/auth/v1/logout', scope: 'local', owner: 'a' }]);
    } finally { await f.close(); }
  });

  test(`a completed newer B login survives A's held logout (${status})`, { timeout: 10_000 }, async () => {
    const f = await fixture(status);
    try {
      const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
      await f.logoutEntered.promise;
      const login = await f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
      assert.equal(login.error, null);
      assert.equal(login.data.session?.user.id, users.b);
      const before = await f.store.getItem(key);
      assert.equal(ownerOf(before), 'b');
      assert(f.events.some(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b'));
      const eventBoundary = f.events.length;
      f.logoutRelease.resolve();
      const result = await ending;
      const afterValue = await f.store.getItem(key);
      const afterSession = await f.client.auth.getSession();
      observations.push({ case: `newer-login-${status}`, result, ownerBeforeRelease: 'b',
        ownerAfterRelease: ownerOf(afterValue), sessionAfterRelease: afterSession.data.session?.user.id ?? null,
        lateEvents: f.events.slice(eventBoundary), requests: f.requests });
      assert.equal(ownerOf(afterValue), 'b', 'A logout must not delete the newer durable B session');
      assert.equal(afterValue, before);
      assert.equal(afterSession.data.session?.user.id, users.b);
      assert(!f.events.slice(eventBoundary).some(entry => entry.event === 'SIGNED_OUT'));
      assert.deepEqual(f.requests, [
        { path: '/auth/v1/logout', scope: 'local', owner: 'a' },
        { path: '/auth/v1/token', grant: 'password', owner: 'b' },
      ]);
    } finally { await f.close(); }
  });
}

for (const status of [204, 503]) {
  test(`a fresh same-user session survives A's held logout (${status})`, { timeout: 10_000 }, async () => {
    const f = await fixture(status, { login: 'a2' });
    try {
      const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
      await f.logoutEntered.promise;
      const login = await f.client.auth.signInWithPassword({ email: 'a2@synthetic.invalid', password: 'synthetic-password' });
      assert.equal(login.error, null);
      assert.equal(login.data.session?.user.id, users.a);
      const before = await f.store.getItem(key);
      assert.equal(sessionId(before), sessions.a2);
      const boundary = f.events.length;
      f.logoutRelease.resolve();
      const result = await ending;
      const afterValue = await f.store.getItem(key);
      observations.push({ case: `same-user-fresh-session-${status}`, result, afterSessionId: sessionId(afterValue),
        lateEvents: f.events.slice(boundary), requests: f.requests });
      assert.equal(afterValue, before, 'Same user with a new session_id is a newer login');
      assert.equal(sessionId((await f.client.auth.getSession()).data.session), sessions.a2);
      assert(!f.events.slice(boundary).some(entry => entry.event === 'SIGNED_OUT'));
    } finally { await f.close(); }
  });

  test(`same-session refresh during A's held logout still permits explicit logout (${status})`, { timeout: 10_000 }, async () => {
    const f = await fixture(status);
    try {
      const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
      await f.logoutEntered.promise;
      const refreshed = await f.client.auth.refreshSession();
      assert.equal(refreshed.error, null);
      assert.equal(sessionId(refreshed.data.session), sessions.a);
      assert.equal(refreshed.data.session?.refresh_token, 'synthetic-refresh-ar');
      assert(f.events.some(entry => entry.event === 'TOKEN_REFRESHED'));
      f.logoutRelease.resolve();
      const result = await ending;
      const afterValue = await f.store.getItem(key);
      observations.push({ case: `same-session-refresh-${status}`, result, owner: ownerOf(afterValue), events: f.events });
      assert.equal(result.ok, true, 'Rotation of A does not supersede the explicit logout of A');
      assert.equal(afterValue, null);
      assert.equal((await f.client.auth.getSession()).data.session, null);
      assert(f.events.some(entry => entry.event === 'SIGNED_OUT'));
    } finally { await f.close(); }
  });

  for (const removalPhase of ['primary', 'chunk-cleanup', 'user-cleanup']) {
    test(`B save issued during A native ${removalPhase} is preserved (${status})`, { timeout: 10_000 }, async () => {
      const f = await fixture(status, { removalPhase, chunked: removalPhase === 'chunk-cleanup' });
      const callbackReads = [];
      const callback = f.client.auth.onAuthStateChange(async event => {
        if (event === 'SIGNED_OUT') callbackReads.push((await f.client.auth.getSession()).data.session?.user.id ?? null);
      });
      try {
        const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
        await f.logoutEntered.promise;
        f.logoutRelease.resolve();
        await f.nativeEntered.promise;
        const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
        await f.loginIssued.promise;
        f.nativeRelease.resolve();
        const [result, login] = await Promise.all([ending, signingIn]);
        const afterValue = await f.store.getItem(key);
        observations.push({ case: `during-native-${removalPhase}-${status}`, result,
          loginError: login.error?.code ?? null, owner: ownerOf(afterValue), events: f.events, callbackReads });
        assert.equal(login.error, null, 'A new login may wait for the short deletion commit, then must succeed');
        assert.equal(ownerOf(afterValue), 'b');
        assert.equal((await f.client.auth.getSession()).data.session?.user.id, users.b);
        const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
        assert(signedIn >= 0);
        assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'),
          'No old SIGNED_OUT may follow the new login event');
        assert(callbackReads.every(value => value === null), 'A SIGNED_OUT callback can read the completed local deletion');
      } finally { callback.data.subscription.unsubscribe(); await f.close(); }
    });
  }

  test(`an already-issued A refresh cannot erase queued B after the SDK removal epoch changes (${status})`,
    { timeout: 10_000 }, async () => {
      const f = await fixture(status, { holdRefreshWrite: true });
      try {
        const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, error: error.name }));
        await f.logoutEntered.promise;
        const refreshing = f.client.auth.refreshSession();
        await f.refreshWriteEntered.promise;
        const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
        await f.loginIssued.promise;
        f.logoutRelease.resolve();
        await f.primaryRemovalIssued.promise;
        f.refreshWriteRelease.resolve();
        const [result, refresh, login] = await Promise.all([ending, refreshing, signingIn]);
        const afterValue = await f.store.getItem(key);
        observations.push({ case: `refresh-epoch-${status}`, result, refreshError: refresh.error?.code ?? null,
          loginError: login.error?.code ?? null, owner: ownerOf(afterValue), events: f.events });
        assert.equal(login.error, null);
        assert.equal(ownerOf(afterValue), 'b', 'Neither old logout nor its refresh epoch cleanup may delete B');
        assert.equal((await f.client.auth.getSession()).data.session?.user.id, users.b);
        const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
        assert(signedIn >= 0);
        assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'));
        assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'TOKEN_REFRESHED'));
      } finally { await f.close(); }
    });
}

test('expired A genuinely refreshes before explicit local logout', { timeout: 10_000 }, async () => {
  const f = await fixture(204);
  try {
    await f.store.setItem(key, JSON.stringify(session('a', { expired: true })));
    const ending = f.signOut();
    await f.logoutEntered.promise;
    assert.deepEqual(f.requests, [
      { path: '/auth/v1/token', grant: 'refresh_token', owner: 'a' },
      { path: '/auth/v1/logout', scope: 'local', owner: 'a' },
    ]);
    assert(f.events.some(entry => entry.event === 'TOKEN_REFRESHED'));
    f.logoutRelease.resolve();
    await ending;
    assert.equal(await f.store.getItem(key), null);
    assert.equal((await f.client.auth.getSession()).data.session, null);
    assert(f.events.some(entry => entry.event === 'SIGNED_OUT'));
    observations.push({ case: 'expired-A-refresh-then-logout', events: f.events, requests: f.requests });
  } finally { await f.close(); }
});

test('native deletion failure releases an already-issued new login without claiming logout', { timeout: 10_000 }, async () => {
  const f = await fixture(204, { removalPhase: 'primary', failNativeDelete: true });
  try {
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
    await f.logoutEntered.promise; f.logoutRelease.resolve(); await f.nativeEntered.promise;
    const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
    await f.loginIssued.promise; f.nativeRelease.resolve();
    const [result, login] = await Promise.all([ending, signingIn]);
    observations.push({ case: 'native-delete-error-release', result, loginError: login.error?.code ?? null, events: f.events });
    assert.equal(result.ok, false);
    assert.equal(login.error, null);
    assert.equal(ownerOf(await f.store.getItem(key)), 'b');
    assert.equal((await f.client.auth.getSession()).data.session?.user.id, users.b);
    assert(!f.events.some(entry => entry.event === 'SIGNED_OUT'), 'A failed native deletion cannot announce logout');
  } finally { await f.close(); }
});

test('a failing real SIGNED_OUT subscriber releases the new login admission lease', { timeout: 10_000 }, async () => {
  const f = await fixture(204, { removalPhase: 'primary' });
  const failed = new Error('Synthetic subscriber failure');
  const callback = f.client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') throw failed; });
  try {
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, message: error.message }));
    await f.logoutEntered.promise; f.logoutRelease.resolve(); await f.nativeEntered.promise;
    const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
    await f.loginIssued.promise; f.nativeRelease.resolve();
    const [result, login] = await Promise.all([ending, signingIn]);
    observations.push({ case: 'subscriber-error-release', result, loginError: login.error?.code ?? null, events: f.events });
    assert.equal(result.ok, false);
    assert.equal(result.message, failed.message);
    assert.equal(login.error, null);
    assert.equal(ownerOf(await f.store.getItem(key)), 'b');
    const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
    assert(signedIn >= 0);
    assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'));
  } finally { callback.data.subscription.unsubscribe(); await f.close(); }
});

test('a delayed same-session refresh cannot be parked and replayed after local logout', { timeout: 10_000 }, async () => {
  const f = await fixture(204, { removalPhase: 'primary', holdRefreshSnapshot: true });
  try {
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
    await f.logoutEntered.promise;
    const refreshing = f.client.auth.refreshSession();
    await f.refreshReadEntered.promise;
    f.logoutRelease.resolve(); await f.nativeEntered.promise;
    const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
    await f.loginIssued.promise;
    f.refreshReadRelease.resolve();
    // The actual SDK refresh must finish with a non-destructive refusal while
    // native deletion is still held; it cannot await replay behind the lease.
    const waiting = Symbol('still waiting for native deletion');
    let timer;
    const refresh = await Promise.race([
      refreshing,
      new Promise(resolve => { timer = setTimeout(() => resolve(waiting), 2_000); }),
    ]).finally(() => clearTimeout(timer));
    assert.notEqual(refresh, waiting, 'Old refresh must refuse instead of waiting for admission to reopen');
    assert.equal(refresh.error?.code, 'session_write_blocked');
    f.nativeRelease.resolve();
    const [result, login] = await Promise.all([ending, signingIn]);
    observations.push({ case: 'delayed-refresh-no-replay', result, refreshError: refresh.error?.code ?? null,
      loginError: login.error?.code ?? null, events: f.events });
    assert.equal(login.error, null);
    assert.equal(ownerOf(await f.store.getItem(key)), 'b');
    assert(!f.events.some(entry => entry.event === 'TOKEN_REFRESHED'));
    const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
    assert(signedIn >= 0);
    assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'));
  } finally { await f.close(); }
});

test('a login issued during initial native capture must never be sent to the logout provider', { timeout: 10_000 }, async () => {
  const f = await fixture(204, { holdCaptureRead: true, observeWrongLogout: true });
  try {
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, code: error.code, name: error.name }));
    await f.captureReadEntered.promise;
    const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
    await f.loginIssued.promise;
    f.captureReadRelease.resolve(); f.logoutRelease.resolve();
    const [result, login] = await Promise.all([ending, signingIn]);
    const afterValue = await f.store.getItem(key);
    observations.push({ case: 'new-login-during-initial-capture', result, loginError: login.error?.code ?? null,
      owner: ownerOf(afterValue), requests: f.requests, events: f.events });
    assert.equal(login.error, null);
    assert(!f.requests.some(entry => entry.path === '/auth/v1/logout' && entry.owner !== 'a'),
      'An old sign-out must not revoke the newer login at the provider');
    assert.equal(ownerOf(afterValue), 'b');
    assert.equal((await f.client.auth.getSession()).data.session?.user.id, users.b);
    const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
    assert(signedIn >= 0);
    assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'));
  } finally { await f.close(); }
});

test('the logout transport guard preserves unrelated methods, scopes, origins and exact request arguments', async () => {
  const calls = [];
  const transport = async (input, init) => { calls.push({ input, init }); return new Response(null, { status: 204 }); };
  const guard = createDeviceSignOutFetch
    ? createDeviceSignOutFetch(origin, () => assert.fail('Unrelated request reached logout ownership guard'), transport)
    : transport;
  const requests = [
    [`${origin}/auth/v1/logout?scope=local`, { method: 'GET' }],
    [`${origin}/auth/v1/logout?scope=global`, { method: 'POST', headers: { authorization: 'Bearer synthetic' } }],
    [`${origin}/auth/v1/logout?scope=others`, { method: 'POST' }],
    [`${origin}/auth/v1/logout?scope=local&scope=global`, { method: 'POST' }],
    [`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', body: '{"synthetic":true}' }],
    ['https://other.synthetic.invalid/auth/v1/logout?scope=local', { method: 'POST' }],
    [new Request(`${origin}/rest/v1/synthetic`, { headers: { 'x-fixture': 'retained' } }), undefined],
  ];
  for (const [input, init] of requests) {
    assert.equal((await guard(input, init)).status, 204);
    assert.equal(calls.at(-1).input, input);
    assert.equal(calls.at(-1).init, init);
  }
  assert.equal(calls.length, requests.length);
});

test('same-session refresh issued during initial native capture still permits explicit logout', { timeout: 10_000 }, async () => {
  const f = await fixture(204, { holdCaptureRead: true, manualCapture: true, holdRefreshSnapshot: true });
  try {
    const refreshing = f.client.auth.refreshSession();
    await f.refreshReadEntered.promise;
    f.armCapture();
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, code: error.code, name: error.name }));
    await f.captureReadEntered.promise;
    f.refreshReadRelease.resolve();
    await f.refreshSaveIssued.promise;
    f.captureReadRelease.resolve(); f.logoutRelease.resolve();
    const [result, refresh] = await Promise.all([ending, refreshing]);
    observations.push({ case: 'same-session-refresh-during-initial-capture', result,
      refreshError: refresh.error?.code ?? null, owner: ownerOf(await f.store.getItem(key)),
      requests: f.requests, events: f.events });
    assert.equal(result.ok, true, 'A same-session rotation does not supersede the logout intent captured for A');
    assert.equal(await f.store.getItem(key), null);
    assert.equal((await f.client.auth.getSession()).data.session, null);
    assert(f.requests.some(entry => entry.path === '/auth/v1/logout' && entry.owner === 'a'));
    assert(f.events.some(entry => entry.event === 'SIGNED_OUT'));
  } finally { await f.close(); }
});

for (const kind of ['user', 'pkce']) for (const persistent of [true, false]) {
test(`${persistent ? 'persistent' : 'transient'} SDK ${kind} cleanup failure requires real logout completion`, { timeout: 10_000 }, async () => {
  const f = await fixture(204, { removalPhase: `${kind}-cleanup`, cleanupFailure: { kind, persistent } });
  try {
    const ending = f.signOut().then(() => ({ ok: true }), error => ({ ok: false, code: error.code, name: error.name }));
    await f.logoutEntered.promise; f.logoutRelease.resolve(); await f.nativeEntered.promise;
    const signingIn = f.client.auth.signInWithPassword({ email: 'b@synthetic.invalid', password: 'synthetic-password' });
    await f.loginIssued.promise; f.nativeRelease.resolve();
    const [result, login] = await Promise.all([ending, signingIn]);
    observations.push({ case: `${persistent ? 'persistent' : 'transient'}-${kind}-cleanup-failure`, result,
      loginError: login.error?.code ?? null, cleanupAttempts: f.cleanupAttempts(),
      owner: ownerOf(await f.store.getItem(key)), events: f.events });
    assert.equal(result.ok, !persistent, 'Success requires the SDK cleanup and notification to complete');
    assert.equal(f.events.filter(entry => entry.event === 'SIGNED_OUT').length, persistent ? 0 : 1);
    assert(f.cleanupAttempts() >= 1 && f.cleanupAttempts() <= 2, 'Secondary cleanup retries remain bounded');
    if (!persistent) assert.equal(f.cleanupAttempts(), 2, 'Transient cleanup recovers through the genuine SDK path');
    assert.equal(login.error, null, 'Secondary cleanup completion or failure must release the new login');
    assert.equal(ownerOf(await f.store.getItem(key)), 'b');
    assert.equal((await f.client.auth.getSession()).data.session?.user.id, users.b);
    const signedIn = f.events.findIndex(entry => entry.event === 'SIGNED_IN' && entry.owner === 'b');
    assert(signedIn >= 0);
    assert(!f.events.slice(signedIn + 1).some(entry => entry.event === 'SIGNED_OUT'));
  } finally { await f.close(); }
});
}

after(() => {
  for (const [path, hash] of Object.entries(sourcePins)) {
    assert.equal(digest(readFileSync(join(repositoryRoot, path))), hash, 'Application source changed during diagnosis');
  }
  console.log(JSON.stringify({ fixture: 'mobile-device-signout-ownership', sdk: '2.115.0',
    sourcePins, runtimePins, observations, sdkMethodsReplaced: false, physicalDeviceClaimed: false,
    externalRequests: 0, sourceMode: 'repository-source-pinned-for-this-run' }));
});
