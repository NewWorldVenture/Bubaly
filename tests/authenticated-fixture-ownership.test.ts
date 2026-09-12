import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type User = { id: string; email: string };
type Member = { id: string; user_id: string; family_id: string };
type Store = { counter: number; users: Map<string, User>; families: Set<string>; members: Member[] };
type Hooks = { before?: (fixtures: object, info: { project: { name: string }; parallelIndex: number }) => Promise<void>; after?: () => Promise<void> };
const nativeRequire = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync('tests/e2e/authenticated.spec.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Execute the actual spec-defined setup/cleanup in separate project modules. */
function loadFixture(store: Store, project: string, parallelIndex = 0, wrongCreatedEmail = false) {
  const hooks: Hooks = {};
  const test = Object.assign(() => undefined, {
    describe: Object.assign((_name: string, fn: () => void) => fn(), { configure: () => undefined }), skip: () => undefined,
    beforeEach: (fn: Hooks['before']) => { hooks.before = fn; }, afterEach: (fn: Hooks['after']) => { hooks.after = fn; },
  });
  const client = {
    auth: { admin: {
      listUsers: async () => ({ data: { users: [...store.users.values()] }, error: null }),
      createUser: async (input: { email: string }) => {
        const user = { id: `user-${++store.counter}`, email: wrongCreatedEmail ? 'different-owner@example.test' : input.email };
        store.users.set(user.id, user); return { data: { user }, error: null };
      },
      deleteUser: async (id: string) => { store.users.delete(id); return { error: null }; },
    } },
    from(table: string) {
      let column = '', value = '', operation = 'read';
      const query = {
        select: () => query, delete: () => { operation = 'delete'; return query; },
        eq: (key: string, wanted: string) => { column = key; value = wanted; return query; },
        then(resolve: (result: { data: Member[]; error: null }) => unknown, reject: (error: unknown) => unknown) {
          let data: Member[] = [];
          if (table === 'family_members') data = store.members.filter(row => row[column as keyof Member] === value);
          if (table === 'families' && operation === 'delete') {
            store.families.delete(value); store.members = store.members.filter(row => row.family_id !== value);
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      }; return query;
    },
  };
  const evaluatedModule = { exports: {} };
  runInNewContext(source, { module: evaluatedModule, exports: evaluatedModule.exports, console, URL, Set,
    process: { env: { E2E_AUTHENTICATED: '1', E2E_AUTH_EMAIL: 'shared-base@example.test', E2E_AUTH_PASSWORD: 'synthetic-password',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' } },
    require: (name: string) => name === '@playwright/test' ? { test, expect } : name === '@supabase/supabase-js' ? { createClient: () => client } : nativeRequire(name),
  }, { filename: `actual-authenticated-${project}.cjs` });
  return { before: () => hooks.before!({}, { project: { name: project }, parallelIndex }), after: () => hooks.after!() };
}
function newStore(): Store { return { counter: 0, users: new Map(), families: new Set(), members: [] }; }
function seedFamily(store: Store, user: User) {
  const family = `family-${user.id}`;
  store.families.add(family); store.members.push({ id: `member-${user.id}`, user_id: user.id, family_id: family });
  return family;
}

describe('authenticated browser fixture ownership', () => {
  it.each([
    ['chromium', 0, 'iphone', 0], ['chromium', 0, 'chromium', 1], ['chromium', 0, 'chromium', 0],
  ] as const)('keeps %s/%s alive while %s/%s sets up and cleans up', async (projectA, workerA, projectB, workerB) => {
    const store = newStore(), first = loadFixture(store, projectA, workerA), second = loadFixture(store, projectB, workerB);
    await first.before();
    const userA = [...store.users.values()][0], familyA = seedFamily(store, userA);
    await second.before();
    expect(store.users.has(userA.id)).toBe(true); expect(store.families.has(familyA)).toBe(true);
    expect(store.users.size).toBe(2);
    const userB = [...store.users.values()].find(user => user.id !== userA.id)!;
    expect(userB.email).not.toBe(userA.email);
    seedFamily(store, userB);
    await second.after();
    expect(store.users.has(userA.id)).toBe(true); expect(store.families.has(familyA)).toBe(true);
    expect(store.users.size).toBe(1);
    await first.after(); expect(store.users.size).toBe(0); expect(store.families.size).toBe(0);
  });
  it('refuses cleanup when an Auth response does not match the allocated fixture email', async () => {
    const store = newStore(), fixture = loadFixture(store, 'chromium', 0, true);
    await fixture.before();
    const user = [...store.users.values()][0], family = seedFamily(store, user);
    await expect(fixture.after()).rejects.toThrow('Refusing to delete an account outside this E2E fixture');
    expect(store.users.has(user.id)).toBe(true); expect(store.families.has(family)).toBe(true);
  });
});
