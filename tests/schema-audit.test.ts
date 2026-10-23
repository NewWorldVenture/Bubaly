import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditSupabaseSchema, runSchemaAuditCli, SCHEMA_CHECKS } from '../scripts/audit-supabase-schema.mjs';

vi.mock('@next/env', () => ({ default: { loadEnvConfig: vi.fn() } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const url = 'https://example.supabase.co';
const key = 'test-api-key';

describe('household schema availability', () => {
  it.each([
    '0240_closet_outfits.sql', '0241_family_watchlist.sql', '0242_home_inventory.sql',
    '0243_sleep_coach.sql', '0244_declutter.sql', '0245_move_planner.sql',
    '0246_home_projects.sql', '0247_career_hub.sql', '0248_language_practice.sql',
    '0250_ai_runtime_core.sql',
  ])('covers every table actually created by %s', (migration) => {
    const sql = readFileSync(resolve('supabase/migrations', migration), 'utf8');
    const tables = [...sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi)]
      .map((match) => match[1]).sort();
    expect(tables.length).toBeGreaterThan(0);
    expect(SCHEMA_CHECKS.filter(([table, file]) => file === migration && !table.includes('.')).map(([table]) => table).sort()).toEqual(tables);
  });

  it('also checks the AI runtime extensions on existing tables', () => {
    for (const table of ['family_automation_runs', 'ai_conversations', 'ai_messages', 'approval_requests']) {
      const check = SCHEMA_CHECKS.find(([name]) => name === `${table}.runtime_columns`);
      expect(check?.[2]).toBeTruthy();
      expect(check?.[2]).not.toBe('*');
    }
  });

  it('keeps checks unique and retains the Stripe claim-column requirement', () => {
    expect(new Set(SCHEMA_CHECKS.map(([name]) => name)).size).toBe(SCHEMA_CHECKS.length);
    expect(SCHEMA_CHECKS).toContainEqual([
      'stripe_webhook_events.claim_columns', '0189_reconcile_stripe_webhook_claims.sql',
      'processing_started_at,claim_token',
    ]);
  });

  it('retrieves zero rows, checks requested columns, and refuses redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]'));
    const results = await auditSupabaseSchema({
      url: `${url}/`, key, fetchImpl,
      checks: [['stripe_webhook_events.claim_columns', '0189.sql', 'processing_started_at,claim_token']],
    });
    const [resource, options] = fetchImpl.mock.calls[0];
    const request = new URL(String(resource));
    expect(request.origin).toBe(url);
    expect(request.pathname).toBe('/rest/v1/stripe_webhook_events');
    expect(request.searchParams.get('limit')).toBe('0');
    expect(request.searchParams.get('select')).toBe('processing_started_at,claim_token');
    expect(options).toMatchObject({ redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${key}` } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(results[0]).toMatchObject({ ok: true, status: 200 });
  });

  it('distinguishes missing tables, permission failures, and provider errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private response', { status: 404 }))
      .mockResolvedValueOnce(new Response('private response', { status: 401 }))
      .mockResolvedValueOnce(new Response('private response', { status: 503 }));
    const results = await auditSupabaseSchema({
      url, key, fetchImpl, checks: [['missing', 'a.sql'], ['private', 'b.sql'], ['offline', 'c.sql']],
    });
    expect(results.map(({ status }) => status)).toEqual([404, 401, 503]);
    expect(results.every(({ ok }) => !ok)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('private response');
  });

  it('bounds parallel requests and preserves report order', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 1));
      active--;
      return new Response('[]');
    });
    const checks = Array.from({ length: 9 }, (_, i) => [`table_${i}`, 'migration.sql']);
    const results = await auditSupabaseSchema({ url, key, fetchImpl, checks });
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(results.map(({ table }) => table)).toEqual(checks.map(([table]) => table));
  });

  it('aborts stalled requests without echoing credentials from exceptions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_resource, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error(`secret: ${key}`)), { once: true });
    }));
    const results = await auditSupabaseSchema({
      url, key, fetchImpl, checks: [['stalled', 'migration.sql']], timeoutMs: 15,
    });
    expect(results[0]).toMatchObject({ ok: false, status: 0, error: 'Request timed out.' });
    expect(JSON.stringify(results)).not.toContain(key);
  });
});

describe('schema audit command and deployment wiring', () => {
  function setupCredentials() {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    vi.stubEnv('SUPABASE_ANON_KEY', 'workflow-public-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('accepts the production workflow public-key variable', async () => {
    setupCredentials();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await runSchemaAuditCli()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(SCHEMA_CHECKS.length);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ apikey: 'workflow-public-key' });
  });

  it('uses server credentials for private infrastructure tables', async () => {
    setupCredentials();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-server-key');
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await runSchemaAuditCli()).toBe(0);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ apikey: 'test-server-key' });
  });

  it('fails the command and names the migration for a missing table', async () => {
    setupCredentials();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (resource) =>
      new URL(String(resource)).pathname.endsWith('/wardrobe_items')
        ? new Response('sensitive diagnostic', { status: 404 }) : new Response('[]')));
    expect(await runSchemaAuditCli()).toBe(1);
    expect(console.error).toHaveBeenCalledWith('MISSING wardrobe_items (0240_closet_outfits.sql)');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('sensitive diagnostic');
  });

  it('rejects missing credentials before making requests', async () => {
    setupCredentials();
    vi.stubEnv('SUPABASE_ANON_KEY', '');
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    expect(await runSchemaAuditCli()).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks schema after migrations and before content backfills', () => {
    const workflow = readFileSync(resolve('.github/workflows/supabase-production-migrations.yml'), 'utf8');
    const migrate = workflow.indexOf('run: supabase db push --yes');
    const verify = workflow.indexOf('run: npm run db:audit:schema');
    const backfill = workflow.indexOf('run: npm run marketing:backfill:provenance');
    expect(migrate).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(migrate);
    expect(verify).toBeLessThan(backfill);
    expect(workflow).toContain("'scripts/audit-supabase-schema.mjs'");
  });
});

// These are request-shape controls with synthetic responses, not evidence that
// a production credential or gateway accepts either key format.
describe('schema audit API-key header compatibility', () => {
  it.each(['sb_secret_synthetic_schema_key', 'sb_publishable_synthetic_schema_key'])(
    'sends opaque key %s only in apikey', async (opaqueKey) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('[]'));
      const results = await auditSupabaseSchema({
        url, key: opaqueKey, fetchImpl, checks: [['workload_snapshots', '0174.sql']],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ apikey: opaqueKey });
      expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 200, ok: true }]);
    },
  );

  it.each([
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic-signature',
    'generic-synthetic-key',
    'SB_SECRET_uppercase_is_not_the_opaque_prefix',
    'prefix-sb_publishable_is_not_the_opaque_prefix',
  ])('preserves dual headers for legacy or unrecognized key %s', async (legacyKey) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('[]'));
    const results = await auditSupabaseSchema({
      url, key: legacyKey, fetchImpl, checks: [['workload_snapshots', '0174.sql']],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ apikey: legacyKey, Authorization: `Bearer ${legacyKey}` });
    expect(results[0]).toMatchObject({ status: 200, ok: true });
  });

  it.each([
    'sb_secret_synthetic_refused_key',
    'sb_publishable_synthetic_refused_key',
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.synthetic-refused-signature',
  ])('keeps all 52 unauthorized checks failing without a credential retry for %s', async (selectedKey) => {
    const publicFallback = 'sb_publishable_unused_public_fallback';
    const workflowFallback = 'unused-workflow-public-fallback';
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', selectedKey);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', publicFallback);
    vi.stubEnv('SUPABASE_ANON_KEY', workflowFallback);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateBody = `private diagnostic: ${selectedKey} ${publicFallback} ${workflowFallback}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(privateBody, { status: 401 }));
    vi.stubGlobal('fetch', fetchImpl);

    expect(SCHEMA_CHECKS).toHaveLength(52);
    expect(await runSchemaAuditCli()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(52);
    const expectedHeaders = selectedKey.startsWith('sb_')
      ? { apikey: selectedKey }
      : { apikey: selectedKey, Authorization: `Bearer ${selectedKey}` };
    const expectedRequests = SCHEMA_CHECKS.map(([table, , columns = '*']) => {
      const endpoint = new URL(`/rest/v1/${table.split('.')[0]}`, url);
      endpoint.searchParams.set('select', columns);
      endpoint.searchParams.set('limit', '0');
      return endpoint.href;
    });
    expect(fetchImpl.mock.calls.map(([resource]) => String(resource)).sort()).toEqual(expectedRequests.sort());
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options?.headers).toEqual(expectedHeaders);
      expect(options?.redirect).toBe('error');
      expect(options?.method ?? 'GET').toBe('GET');
    }
    expect(logged).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(54);
    const format = selectedKey.startsWith('sb_secret_') ? 'opaque-secret'
      : selectedKey.startsWith('sb_publishable_') ? 'opaque-publishable' : 'jwt-shaped';
    expect(errors).toHaveBeenNthCalledWith(1,
      `Schema audit credential selection: source=SUPABASE_SERVICE_ROLE_KEY, format=${format} (format is not validity or privilege proof).`);
    for (const [table] of SCHEMA_CHECKS) {
      expect(errors).toHaveBeenCalledWith(`ERROR   ${table} (HTTP 401)`);
    }
    expect(errors).toHaveBeenLastCalledWith('\nSchema audit failed: 52 of 52 required schema checks unavailable.');
    const output = JSON.stringify([...logged.mock.calls, ...errors.mock.calls]);
    for (const privateValue of [privateBody, selectedKey, publicFallback, workflowFallback]) {
      expect(output).not.toContain(privateValue);
    }
  });
});

describe('schema audit redacted failure diagnostics', () => {
  const privateText = 'PRIVATE: sb_secret_never_log_this user@example.invalid';
  const jsonFailure = (status: number, value: unknown) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  const check = [['workload_snapshots', '0174.sql']];

  it.each([
    [401, 'PGRST301', 'jwt-rejection-reported'],
    [401, 'PGRST302', 'authentication-required-reported'],
    [401, 'PGRST303', 'jwt-claims-rejection-reported'],
    [401, '42501', 'insufficient-privilege-reported'],
    [403, '42501', 'insufficient-privilege-reported'],
    [500, 'PGRST300', 'jwt-verifier-unavailable-reported'],
  ])('records only the fixed category for HTTP %i and %s', async (status, code, diagnosis) => {
    const results = await auditSupabaseSchema({
      url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonFailure(Number(status), {
        code, message: privateText, hint: privateText, details: { secret: privateText },
      })),
    });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status, ok: false, diagnosis }]);
    expect(JSON.stringify(results)).not.toContain(privateText);
    expect(JSON.stringify(results)).not.toContain(String(code));
  });

  it('recognizes only the exact code-less API-key rejection literal', async () => {
    const results = await auditSupabaseSchema({
      url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonFailure(401, {
        message: 'Invalid API key', hint: privateText,
      })),
    });
    expect(results[0]).toMatchObject({ status: 401, ok: false, diagnosis: 'api-key-rejection-reported' });
    expect(JSON.stringify(results)).not.toContain(privateText);
  });

  it.each([
    [403, { message: 'Invalid API key' }],
    [401, { code: 'unknown-private-code', message: 'Invalid API key' }],
    [401, { code: null, message: 'Invalid API key' }],
    [401, { code: ['PGRST301'] }],
    [401, { code: 'constructor' }],
    [401, { code: 'pgrst301' }],
    [403, { code: 'PGRST301' }],
    [401, { code: 'PGRST300' }],
    [500, { code: '42501' }],
    [401, { message: 'Invalid API key with private details' }],
    [401, { hint: 'PGRST301', details: 'Invalid API key' }],
    [401, [{ code: 'PGRST301' }]],
    [401, null],
    [401, 'PGRST301'],
  ])('does not infer a category from contradictory or unknown payload %#', async (status, payload) => {
    const results = await auditSupabaseSchema({
      url, key, checks: check,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonFailure(status, payload)),
    });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status, ok: false }]);
  });

  it.each(['text/plain', 'text/html'])('ignores a JSON-looking body served as %s', async (contentType) => {
    const response = new Response('{"code":"PGRST301"}', { status: 401, headers: { 'content-type': contentType } });
    const reader = vi.spyOn(response.body!, 'getReader');
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(reader).not.toHaveBeenCalled();
    expect(results[0]).toEqual({ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false });
  });

  it('retains observed HTTP status when body cancellation rejects', async () => {
    const response = new Response(privateText, { status: 401 });
    const cancel = vi.spyOn(response.body!, 'cancel').mockRejectedValueOnce(new Error(privateText));
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retains observed HTTP status when reading diagnostic bytes fails', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateText)); } }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 403, ok: false }]);
  });

  it.each(['{"code":"PGRST301"', 'not-json-private-diagnostic'])('ignores malformed JSON without losing the HTTP status: %#', async (body) => {
    const response = new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
  });

  it('ignores invalid UTF-8 instead of classifying replacement text', async () => {
    const prefix = new TextEncoder().encode('{"code":"PGRST301","details":"');
    const suffix = new TextEncoder().encode('"}');
    const body = new Uint8Array(prefix.length + 2 + suffix.length);
    body.set(prefix); body.set([0xc3, 0x28], prefix.length); body.set(suffix, prefix.length + 2);
    const response = new Response(body, {
      status: 401, headers: { 'content-type': 'application/json' },
    });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
  });

  it('retains observed HTTP status when diagnostic header inspection throws', async () => {
    const response = jsonFailure(401, { code: 'PGRST301' });
    vi.spyOn(response.headers, 'get').mockImplementation(() => { throw new Error(privateText); });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
  });

  it('never reads a successful JSON body and preserves success if cleanup rejects', async () => {
    const response = jsonFailure(200, { code: 'PGRST301', message: privateText });
    const reader = vi.spyOn(response.body!, 'getReader');
    const json = vi.spyOn(response, 'json');
    const text = vi.spyOn(response, 'text');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const blob = vi.spyOn(response, 'blob');
    const cancel = vi.spyOn(response.body!, 'cancel').mockRejectedValueOnce(new Error(privateText));
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(reader).not.toHaveBeenCalled();
    for (const method of [json, text, arrayBuffer, blob]) expect(method).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 200, ok: true }]);
  });

  it('bounds diagnostic bytes, including multibyte text, and cancels the stream', async () => {
    const cancelled = vi.fn();
    const oversized = new TextEncoder().encode(JSON.stringify({ code: 'PGRST301', details: '😀'.repeat(1100) }));
    expect(oversized.byteLength).toBeGreaterThan(4096);
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(oversized); }, cancel: cancelled,
    }), { status: 401, headers: { 'content-type': 'application/json' } });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results[0]).not.toHaveProperty('diagnosis');
    expect(results[0]).toMatchObject({ status: 401, ok: false });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 4096 bytes across chunks without emitting private padding', async () => {
    const base = JSON.stringify({ code: 'PGRST301', details: '' });
    const body = new TextEncoder().encode(JSON.stringify({ code: 'PGRST301', details: 'x'.repeat(4096 - base.length) }));
    expect(body.byteLength).toBe(4096);
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(body.slice(0, 9)); controller.enqueue(body.slice(9)); controller.close();
      },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results[0]).toMatchObject({ status: 401, diagnosis: 'jwt-rejection-reported' });
    expect(JSON.stringify(results)).not.toContain('xxxxx');
  });

  it('rejects a valid error payload exactly one byte over the accepted-body limit', async () => {
    const base = JSON.stringify({ code: 'PGRST301', details: '' });
    const body = JSON.stringify({ code: 'PGRST301', details: 'x'.repeat(4097 - base.length) });
    expect(new TextEncoder().encode(body).byteLength).toBe(4097);
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, { status: 401, headers: { 'content-type': 'application/json' } }),
    ) });
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
  });

  it('bounds empty chunks without waiting for a starved timeout', async () => {
    const cancelled = vi.fn();
    const pulled = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array()));
    const response = new Response(new ReadableStream({ pull: pulled, cancel: cancelled }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    expect(results[0]).toEqual({ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false });
    expect(pulled.mock.calls.length).toBeLessThanOrEqual(129);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('uses the original deadline for a stalled body even when cancellation never settles', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const results = await auditSupabaseSchema({ url, key, checks: check, fetchImpl, timeoutMs: 15 });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(results).toEqual([{ table: 'workload_snapshots', migration: '0174.sql', status: 401, ok: false }]);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_synthetic_refused', 'opaque-secret'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'sb_publishable_synthetic_refused', 'opaque-publishable'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'not-base64.not-decoded.not-verified', 'jwt-shaped'],
    ['SUPABASE_ANON_KEY', 'unknown-synthetic-refused', 'unrecognized'],
  ])('reports fixed selection metadata for %s without exposing or replacing its value', async (source, selectedKey, format) => {
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']) vi.stubEnv(name, '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    vi.stubEnv(source, selectedKey);
    if (source === 'SUPABASE_SERVICE_ROLE_KEY') vi.stubEnv('SUPABASE_ANON_KEY', 'never-retry-this-fallback');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonFailure(401, {
      code: 'PGRST301', message: selectedKey, hint: privateText,
    }));
    vi.stubGlobal('fetch', fetchImpl);
    expect(await runSchemaAuditCli()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(52);
    for (const [, options] of fetchImpl.mock.calls) expect(options?.headers).toHaveProperty('apikey', selectedKey);
    expect(errors).toHaveBeenNthCalledWith(1,
      `Schema audit credential selection: source=${source}, format=${format} (format is not validity or privilege proof).`);
    for (const [table] of SCHEMA_CHECKS) expect(errors).toHaveBeenCalledWith(`ERROR   ${table} (HTTP 401) [jwt-rejection-reported]`);
    expect(errors).toHaveBeenLastCalledWith('\nSchema audit failed: 52 of 52 required schema checks unavailable.');
    const output = JSON.stringify([...errors.mock.calls, ...logs.mock.calls]);
    for (const hidden of [selectedKey, privateText, 'never-retry-this-fallback', 'PGRST301']) expect(output).not.toContain(hidden);
    expect(logs).not.toHaveBeenCalled();
  });
});

// Native localhost presence checks: the server models PostgREST's select-list
// admission, not database rows, permissions, CRUD or provider execution.
const omittedRunColumns = ['run_type', 'progress', 'started_at', 'completed_at', 'error'] as const;
function declaredRunColumns() {
  const sql = readFileSync(resolve('supabase/migrations/0250_ai_runtime_core.sql'), 'utf8');
  const start = sql.indexOf('alter table public.family_automation_runs');
  const end = sql.indexOf(';', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [...sql.slice(start, end).matchAll(/add\s+column\s+if\s+not\s+exists\s+(\w+)/gi)].map((match) => match[1]);
}

async function withRunColumnServer(
  missing: string | null,
  action: (base: string, requests: { method: string | undefined; path: string; limit: string | null; selected: string[]; keyMatched: boolean }[]) => Promise<void>,
) {
  const { createServer } = await import('node:http');
  const available = new Set(declaredRunColumns().filter((name) => name !== missing));
  const requests: Parameters<typeof action>[1] = [];
  const server = createServer((request, response) => {
    const endpoint = new URL(request.url ?? '/', 'http://127.0.0.1');
    const selected = (endpoint.searchParams.get('select') ?? '').split(',');
    const keyMatched = request.headers.apikey === 'synthetic-schema-native-key'
      && request.headers.authorization === 'Bearer synthetic-schema-native-key';
    requests.push({ method: request.method, path: endpoint.pathname, limit: endpoint.searchParams.get('limit'), selected, keyMatched });
    const invalid = request.method !== 'GET' || endpoint.searchParams.get('limit') !== '0' || !keyMatched;
    const absent = endpoint.pathname === '/rest/v1/family_automation_runs'
      && selected.some((name) => !available.has(name));
    response.writeHead(invalid ? 403 : absent ? 400 : 200, { 'Content-Type': 'application/json' });
    response.end(invalid ? '{"message":"synthetic-private-header-diagnostic"}'
      : absent ? '{"message":"synthetic-private-column-diagnostic"}' : '[]');
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic schema listener did not bind TCP');
  let primary: unknown;
  let cleanup: unknown;
  try { await action(`http://127.0.0.1:${address.port}`, requests); }
  catch (error) { primary = error; }
  finally {
    server.closeAllConnections();
    try { await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())); }
    catch (error) { cleanup = error; }
  }
  if (primary) throw primary;
  if (cleanup) throw cleanup;
  expect(server.listening).toBe(false);
}

describe('every canonical automation-run column is required over native HTTP', () => {
  it('selects all eighteen columns declared by 0250 exactly once without widening the fifty-two targets', () => {
    const declared = declaredRunColumns();
    expect(declared).toHaveLength(18);
    const check = SCHEMA_CHECKS.find(([name]) => name === 'family_automation_runs.runtime_columns');
    expect(check?.[1]).toBe('0250_ai_runtime_core.sql');
    const selected = check?.[2]?.split(',') ?? [];
    expect(selected).toHaveLength(18);
    expect(new Set(selected).size).toBe(18);
    expect([...selected].sort()).toEqual([...declared].sort());
    expect(SCHEMA_CHECKS).toHaveLength(52);
  });

  it('accepts the healthy whole fifty-two-check catalog with zero-row native requests and canonical run selection', async () => {
    await withRunColumnServer(null, async (base, requests) => {
      const results = await auditSupabaseSchema({ url: base, key: 'synthetic-schema-native-key' });
      expect(results).toHaveLength(52);
      expect(results.every(({ ok, status }) => ok && status === 200)).toBe(true);
      expect(requests).toHaveLength(52);
      expect(requests.every((request) => request.method === 'GET' && request.limit === '0' && request.keyMatched)).toBe(true);
      const run = requests.filter(({ path }) => path === '/rest/v1/family_automation_runs');
      expect(run).toHaveLength(1);
      expect([...run[0].selected].sort()).toEqual([...declaredRunColumns()].sort());
    });
  });

  it.each(omittedRunColumns)('refuses a catalog missing only %s; omitting that requirement causally restores the false green', async (missing) => {
    await withRunColumnServer(missing, async (base, requests) => {
      const results = await auditSupabaseSchema({ url: base, key: 'synthetic-schema-native-key' });
      expect(results).toHaveLength(52);
      const failed = results.filter(({ ok }) => !ok);
      expect(failed).toEqual([{ table: 'family_automation_runs.runtime_columns', migration: '0250_ai_runtime_core.sql', status: 400, ok: false }]);
      expect(results.filter(({ ok }) => ok)).toHaveLength(51);
      expect(JSON.stringify(results)).not.toContain('synthetic-private-column-diagnostic');
      expect(requests).toHaveLength(52);
      const weakened = SCHEMA_CHECKS.map(([name, migration, columns]) => name === 'family_automation_runs.runtime_columns'
        ? [name, migration, columns.split(',').filter((column: string) => column !== missing).join(',')]
        : [name, migration, columns]);
      const blind = await auditSupabaseSchema({ url: base, key: 'synthetic-schema-native-key', checks: weakened });
      expect(blind).toHaveLength(52);
      expect(blind.every(({ ok, status }) => ok && status === 200)).toBe(true);
      expect(requests).toHaveLength(104);
      expect(requests.every((request) => request.method === 'GET' && request.limit === '0' && request.keyMatched)).toBe(true);
    });
  });
});
