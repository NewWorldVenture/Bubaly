import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person may connect two accounts of one calendar provider — personal and
 * work — and sync_accounts stores that as two rows (unique on user_id,
 * provider, external_id); the disconnect route already handles it. "Sync now"
 * (both /api/sync/run and /api/sync/google/sync) read the account with
 * maybeSingle, which errors on the second row, so the whole sync answered
 * "sync failed" (503) for exactly those people. The provider page read with no
 * user_id at all, so a spouse's connection showed as the viewer's own.
 */

const state = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; user_id: string; family_id: string; external_id: string }>,
  synced: [] as string[],
  audits: 0,
  results: {} as Record<string, { imported: number; exported: number; skipped: number; conflicts: number; error?: string }>,
}));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-1' }, active: { familyId: 'f-1' } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {};
    let eqs = 0;
    Object.assign(chain, {
      from: () => chain, select: () => chain,
      eq: () => { eqs += 1; return eqs >= 3 ? Promise.resolve({ data: state.accounts, error: null }) : chain; },
      maybeSingle: () => Promise.reject(new Error('maybeSingle must not be used here: JSON object requested, multiple (or no) rows returned')),
    });
    return chain;
  },
}));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ label: 'Outlook', isConfigured: () => true }) }));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_admin: unknown, account: { id: string }) => { state.synced.push(account.id); return state.results[account.id]; },
}));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/sync/audit', () => ({ logSyncAudit: async () => { state.audits += 1; } }));

async function syncNow() {
  const { POST } = await import('@/app/api/sync/run/route');
  const res = await POST(new Request('https://bubaly.test/api/sync/run', { method: 'POST', body: JSON.stringify({ provider: 'microsoft' }) }));
  return { status: res.status, body: await res.json() };
}

describe('Sync now with two accounts of one provider', () => {
  beforeEach(() => {
    vi.resetModules();
    state.accounts = [
      { id: 'personal', user_id: 'u-1', family_id: 'f-1', external_id: 'me@outlook.test' },
      { id: 'work', user_id: 'u-1', family_id: 'f-1', external_id: 'me@work.test' },
    ];
    state.synced = []; state.audits = 0;
    state.results = {
      personal: { imported: 3, exported: 1, skipped: 0, conflicts: 0 },
      work: { imported: 2, exported: 0, skipped: 1, conflicts: 1 },
    };
  });

  // The finding.
  it('syncs both accounts and reports the combined result', async () => {
    const { status, body } = await syncNow();
    expect(status).toBe(200);
    expect(state.synced).toEqual(['personal', 'work']);
    expect(body).toEqual({ imported: 5, exported: 1, skipped: 1, conflicts: 1 });
    expect(state.audits).toBe(2);
  });

  it('does not let one account that worked hide one that failed', async () => {
    state.results.work = { imported: 0, exported: 0, skipped: 0, conflicts: 0, error: 'Work calendar token expired.' };
    const { status, body } = await syncNow();
    expect(status).toBe(502);
    expect(body.error).toBe('Work calendar token expired.');
    expect(body.imported).toBe(3);
  });

  it('still says "not connected" when there is no account (control)', async () => {
    state.accounts = [];
    const { status } = await syncNow();
    expect(status).toBe(400);
    expect(state.synced).toEqual([]);
  });
});

describe('the other readers', () => {
  it('Google "Sync now" also reads every account rather than one', () => {
    const source = readFileSync('app/api/sync/google/sync/route.ts', 'utf8');
    const read = source.slice(source.indexOf(".from('sync_accounts')"), source.indexOf('if (accountError)'));
    expect(read).not.toContain('maybeSingle');
    expect(source).toMatch(/for \(const account of accounts\)/);
  });

  it('the provider page shows only the viewer\'s own accounts', () => {
    const source = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');
    const read = source.slice(source.indexOf(".from('sync_accounts')"), source.indexOf('const account ='));
    expect(read).toContain(".eq('user_id', ctx.user.id)");
    expect(read).not.toContain('maybeSingle');
  });
});
