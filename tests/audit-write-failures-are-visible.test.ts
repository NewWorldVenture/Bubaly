// An audit-log write that did not land has to be noticeable.
//
// logAudit wrapped its insert in try/catch and logged from the catch. That
// looks like error handling and is not: a PostgREST call RESOLVES with
// { data, error } and rejects only under .throwOnError(). Without it, even a
// fetch-level failure is caught inside the builder and converted into a
// resolved error — the library's own source does this:
//
//     this.shouldThrowOnError = false;                        // default
//     if (!this.shouldThrowOnError) res = res.catch((fetchError) => { … });
//
// So the catch could never see an RLS denial, a constraint violation, a column
// mismatch or a dead connection. `console.error('[audit] failed to write log')`
// had never run and could not run, and every audit-write failure across all 14
// callers was silent by construction. Nothing about it was visible to tsc
// either: awaiting a promise and ignoring its value is perfectly legal.
//
// The same shape was written out longhand at ten wallet-audit call sites, so a
// transfer, a card issue or a claimed Pay-ID could be recorded with no audit
// row at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { logAudit, logWalletAudit } from '@/lib/server/audit';

type Outcome = { error: { code: string; message: string } | null };

/** A client whose insert RESOLVES with an error, the way PostgREST does. */
function resolvingClient(outcome: Outcome) {
  const inserted: unknown[] = [];
  const client = {
    from: () => ({
      insert: async (row: unknown) => { inserted.push(row); return { data: null, ...outcome }; },
    }),
  } as unknown as SupabaseClient<Database>;
  return { client, inserted };
}

/** A client that throws synchronously while the query is built. */
function throwingClient() {
  return {
    from: () => { throw new Error('client has no URL'); },
  } as unknown as SupabaseClient<Database>;
}

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); });

const ENTRY = {
  familyId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  action: 'update',
  resource: 'child_logins',
} as const;

const WALLET_ROW = {
  family_id: '11111111-1111-4111-8111-111111111111',
  actor_user_id: '22222222-2222-4222-8222-222222222222',
  action: 'funds_added',
  entity_type: 'child_wallets',
  detail: 'Added 500 cents',
} as Database['public']['Tables']['wallet_audit_logs']['Insert'];

describe('logAudit reports a write that resolved with an error', () => {
  it('says so when the row was refused', async () => {
    // The whole defect in one assertion: this is the failure mode that actually
    // happens in production, and it used to produce nothing at all.
    const { client } = resolvingClient({ error: { code: '42501', message: 'permission denied for table audit_logs' } });
    await logAudit(client, ENTRY);
    expect(logged, 'a refused audit write produced no output at all').toHaveLength(1);
    expect(logged[0][0]).toBe('[audit] failed to write log');
    expect(logged[0][1], 'and the error itself has to reach the log, not just a label')
      .toMatchObject({ code: '42501' });
  });

  it('stays quiet when the row landed', async () => {
    // The distinction only means something if a success is silent.
    const { client, inserted } = resolvingClient({ error: null });
    await logAudit(client, ENTRY);
    expect(logged).toHaveLength(0);
    expect(inserted).toHaveLength(1);
  });

  it('still survives a client that throws while building the query', async () => {
    // The one path that can still reach the catch. It must not escape into the
    // caller: an audit log is never worth failing the action it describes.
    await expect(logAudit(throwingClient(), ENTRY)).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });

  it('never rejects, whatever happened', async () => {
    const { client } = resolvingClient({ error: { code: '23503', message: 'foreign key violation' } });
    await expect(logAudit(client, ENTRY)).resolves.toBeUndefined();
  });
});

describe('logWalletAudit reports a money row that was not recorded', () => {
  it('names the operation, so the log says which movement lost its record', async () => {
    const { client } = resolvingClient({ error: { code: '42501', message: 'permission denied' } });
    await logWalletAudit(client, WALLET_ROW, 'added funds');
    expect(logged).toHaveLength(1);
    expect(logged[0][0], 'an unnamed failure cannot be traced back to a transfer')
      .toBe('[wallet-audit] added funds was not recorded');
    expect(logged[0][1]).toMatchObject({ code: '42501' });
  });

  it('stays quiet when the row landed', async () => {
    const { client, inserted } = resolvingClient({ error: null });
    await logWalletAudit(client, WALLET_ROW, 'added funds');
    expect(logged).toHaveLength(0);
    expect(inserted).toEqual([WALLET_ROW]);
  });

  it('does not fail the caller — the money has already moved', async () => {
    // Refusing a completed transfer because its audit row failed would turn a
    // bookkeeping problem into a financial one.
    const { client } = resolvingClient({ error: { code: '08006', message: 'connection failure' } });
    await expect(logWalletAudit(client, WALLET_ROW, 'wallet credit (allowance)')).resolves.toBeUndefined();
    await expect(logWalletAudit(throwingClient(), WALLET_ROW, 'card spend')).resolves.toBeUndefined();
    expect(logged).toHaveLength(2);
  });
});

describe('every wallet audit write goes through the one helper', () => {
  it('leaves no call site discarding the result longhand', async () => {
    // Ten sites wrote this out by hand and every one dropped the error. The
    // helper is only worth having if nothing bypasses it.
    const { readdirSync, readFileSync } = await import('node:fs');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '.git', '.claude', 'mobile'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
      }
      return out;
    };
    const offenders = [...walk('app'), ...walk('lib')]
      .filter((file) => file !== 'lib/server/audit.ts')
      .filter((file) => /from\(\s*'wallet_audit_logs'\s*\)\s*\.insert/.test(readFileSync(file, 'utf8')));
    expect(offenders, 'use logWalletAudit so the failure is reported once, correctly').toEqual([]);
  });
});
