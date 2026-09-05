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
