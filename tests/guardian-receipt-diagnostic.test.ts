import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { requireLocalOrigin } from './e2e/helpers/durable-session';

type Reply = { status: unknown; error: { code?: unknown } | null; data: unknown };
type Row = Record<string, unknown>;
const source = ts.transpileModule(readFileSync('tests/e2e/guardian-receipt-authority.spec.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Run the actual authority spec; all account/SDK I/O is synthetic and local. */
async function runAuthorityFixture(changed: Reply) {
  let run!: (fixtures: { baseURL: string }) => Promise<void>;
  const test = Object.assign((name: string, callback: typeof run) => {
    if (name.startsWith('family members can file')) run = callback;
  }, { describe: (_name: string, callback: () => void) => callback(), use: () => {}, skip: () => {}, setTimeout: () => {} });
  const accounts: Array<{ userId: string; email: string; familyId: string; password: string; dispose: ReturnType<typeof vi.fn> }> = [];
  let receipt: Row | undefined;
  const forbiddenNetwork = vi.fn(() => { throw new Error('Synthetic fixture attempted network I/O'); });
  const createClient = vi.fn((origin: string, key: string) => {
    requireLocalOrigin(origin);
    const admin = key === 'synthetic-service';
    let userId: string | undefined;
    return {
      auth: { signInWithPassword: async ({ email }: { email: string }) => {
        userId = accounts.find(account => account.email === email)?.userId;
        return { error: null, data: { user: { id: userId }, session: {} } };
      } },
      from(table: string) {
        let operation = 'select', row: Row = {}, single = false;
        const filters: Row = {};
        const query = {
          insert: (value: Row) => { operation = 'insert'; row = value; return query; },
          update: () => { operation = 'update'; return query; },
          delete: () => { operation = 'delete'; return query; },
          select: () => query,
          eq: (column: string, value: unknown) => { filters[column] = value; return query; },
          single: () => { single = true; return query; },
          then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            let result: Reply;
            if (table === 'guardian_communications' && operation === 'insert') result = { status: 201, error: null, data: [{ id: row.id }] };
            else if (table !== 'ai_tool_calls') throw new Error('Unexpected synthetic table');
            else if (operation === 'update') result = changed;
            else if (operation === 'insert' && !admin) result = { status: 403, error: { code: '42501' }, data: null };
            else if (operation === 'insert') { receipt = row; result = { status: 201, error: null, data: null }; }
            else if (operation === 'delete') result = { status: 200, error: null, data: [] };
            else if (single && receipt) result = { status: 200, error: null, data: {
              inputs: receipt.inputs, outputs: receipt.outputs, state: receipt.state, resource_id: receipt.resource_id,
            } };
            else result = { status: 200, error: null, data: receipt && filters.id === receipt.id
              && (admin || userId === accounts[0].userId) ? [{ id: receipt.id }] : [] };
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    };
  });
  const evaluated = { exports: {} };
  runInNewContext(source, {
    module: evaluated, exports: evaluated.exports, fetch: forbiddenNetwork,
    process: { env: { E2E_DURABLE_SESSION: '1', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service' } },
    require(name: string) {
      if (name === '@playwright/test') return { test, expect };
      if (name === 'node:crypto') return { randomUUID };
      if (name === '@supabase/supabase-js') return { createClient };
      if (name === './helpers/durable-session') return { requireLocalOrigin, createOwnedAccount: async (origin: string) => {
        requireLocalOrigin(origin);
        const serial = accounts.length + 1;
        const account = { userId: `synthetic-user-${serial}`, familyId: `synthetic-family-${serial}`,
          email: `synthetic-${serial}@example.invalid`, password: 'synthetic-password', dispose: vi.fn(async () => {}) };
        accounts.push(account); return account;
      } };
      throw new Error('Unexpected synthetic fixture import');
    },
  });
  let failure: unknown;
  try { await run({ baseURL: 'http://localhost:3107' }); } catch (error) { failure = error; }
  expect(forbiddenNetwork).not.toHaveBeenCalled();
  expect(accounts).toHaveLength(2);
  for (const account of accounts) expect(account.dispose).toHaveBeenCalledOnce();
  return failure;
}

describe('guardian receipt UPDATE diagnostic in the actual fixture', () => {
  it.each([
    { status: 200, error: null, data: [] },
    { status: 403, error: { code: '42501' }, data: null },
  ])('preserves permitted denial outcome %#', async result => {
    expect(await runAuthorityFixture(result)).toBeUndefined();
  });

  it.each([
    [{ status: 200, error: null, data: [{ id: 'SYNTHETIC_PRIVATE_ROW_ID' }] }, 'status=200 code=none rows=1'],
    [{ status: 503, error: { code: 'PGRST000' }, data: null }, 'status=503 code=PGRST000 rows=unavailable'],
    [{ status: 500, error: { code: '08006' }, data: null }, 'status=500 code=08006 rows=unavailable'],
    [{ status: 0, error: { code: '' }, data: null }, 'status=0 code=unavailable rows=unavailable'],
    [{ status: 99, error: { code: '42501\nSYNTHETIC_PRIVATE_DETAIL' }, data: { id: 'SYNTHETIC_PRIVATE_ROW_ID' } }, 'status=unavailable code=unavailable rows=unavailable'],
  ] satisfies Array<[Reply, string]>)('keeps unexpected outcome %# failing with bounded metadata', async (result, diagnostic) => {
    const failure = await runAuthorityFixture(result);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`A family manager must not update the receipt (${diagnostic})`);
    expect((failure as Error).message).not.toContain('SYNTHETIC_PRIVATE');
  });

  it('does not read provider details, response metadata or returned row contents', async () => {
    const poison = () => { throw new Error('SYNTHETIC_PRIVATE_DETAIL was accessed'); };
    const error = { code: 'PGRST301', get message() { return poison(); }, get details() { return poison(); }, get hint() { return poison(); } };
    const result = { status: 401, error, data: [{ get id() { return poison(); } }], get statusText() { return poison(); },
      get headers() { return poison(); }, get body() { return poison(); } };
    const failure = await runAuthorityFixture(result);
    expect((failure as Error).message).toContain('status=401 code=PGRST301 rows=1');
    expect((failure as Error).message).not.toContain('SYNTHETIC_PRIVATE');
  });
});
