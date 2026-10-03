import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { admitRpc, type AdmitArgs } from './helpers/admit-ai-request';

// F19 on the public gift route. The allowance is a COUNT of the family's
// `ai_requests` rows, so a route that checks the count but files no row lets a
// Free family at 9 of 10 stay at 9 and call the model without end. This drives
// the real route and the real allowance helper against an in-memory ledger:
// the last free request is filed, and the one after it is refused before the
// provider is reached.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  failInsert: false,
  providerCalls: 0,
  planLevel: 0,
}));

function fakeDb() {
  const client = {
    // F19 (0477): a capped family's row is filed through `admit_ai_request`,
    // emulated over this same table, with its per-family lock.
    rpc: (name: string, args: AdmitArgs) => admitRpc(client)(name, args),
    from(table: string) {
      if (table === 'gift_links') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'link-1', is_active: true, occasion: 'birthday', child_wallet_id: null, family_id: 'fam-1' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'ai_requests') {
        return {
          // The allowance read: select(..., { head: true }).eq(family).eq(metered).gte(created_at)
          select: (_cols: string, opts?: { head?: boolean }) => {
            if (opts?.head) {
              const filters: Array<(r: Record<string, unknown>) => boolean> = [];
              const head = {
                eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return head; },
                gte: async () => ({ count: state.rows.filter((r) => filters.every((f) => f(r))).length, error: null }),
              };
              return head;
            }
            throw new Error('unexpected ai_requests select');
          },
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (state.failInsert) return { data: null, error: { message: 'insert refused' } };
                const id = `req-${state.rows.length + 1}`;
                state.rows.push({ metered: true, ...row, id });
                return { data: { id }, error: null };
              },
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => ({
              select: async () => {
                const row = state.rows.find((r) => r.id === id);
                if (row) Object.assign(row, patch);
                return { data: row ? [{ id }] : [], error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return client;
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeDb() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => state.planLevel,
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async () => {
      state.providerCalls += 1;
      return { text: JSON.stringify({ messages: ['Happy birthday!'], amounts: [1000] }) };
    },
  }),
}));
vi.mock('@/lib/wallet/gift-ai', () => ({
  buildGiftAssistPrompt: () => ({ system: 's', user: 'u' }),
  parseGiftSuggestions: () => ({ messages: ['Happy birthday!'], amounts: [1000] }),
}));

function call() {
  return new NextRequest('http://localhost/api/ai/gift', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok-1' }),
  });
}

function seed(n: number) {
  for (let i = 0; i < n; i++) state.rows.push({ id: `old-${i}`, family_id: 'fam-1', kind: 'feature', metered: true });
}

describe('a gift-link request counts against the family allowance (F19)', () => {
  beforeEach(() => {
    state.rows = [];
    state.failInsert = false;
    state.providerCalls = 0;
    state.planLevel = 0;
  });

  it('files the last free request, then refuses the next one before the provider', async () => {
    const { POST } = await import('@/app/api/ai/gift/route');
    seed(9);
    const first = await POST(call());
    expect(first.status).toBe(200);
    expect(state.rows.filter((r) => r.feature === 'gift')).toHaveLength(1);
    expect(state.rows.find((r) => r.feature === 'gift')).toMatchObject({
      family_id: 'fam-1', requested_by: null, kind: 'feature', status: 'completed',
    });

    const second = await POST(call());
    expect(second.status).toBe(429);
    expect(state.providerCalls).toBe(1);
  });

  it('two requests racing at 9 of 10: one is answered, one is refused, the provider is called once', async () => {
    // The check-then-file race (F19): both requests read 9 before either row
    // lands. Admission counts and files under one per-family lock, so the
    // second is counted against the first's row.
    const { POST } = await import('@/app/api/ai/gift/route');
    seed(9);
    const statuses = (await Promise.all([POST(call()), POST(call())])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect(state.providerCalls).toBe(1);
    expect(state.rows).toHaveLength(10);
  });

  it('refuses rather than calling the model when the request cannot be filed', async () => {
    const { POST } = await import('@/app/api/ai/gift/route');
    state.failInsert = true;
    const res = await POST(call());
    expect(res.status).toBe(503);
    expect(state.providerCalls).toBe(0);
  });

  it('an unlimited plan is still filed, and never refused', async () => {
    const { POST } = await import('@/app/api/ai/gift/route');
    state.planLevel = 1;
    seed(50);
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(state.providerCalls).toBe(1);
    expect(state.rows.filter((r) => r.feature === 'gift')).toHaveLength(1);
  });
});
