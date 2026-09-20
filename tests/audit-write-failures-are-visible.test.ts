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

// The same dead catch, in the highest-stakes place in the product.
//
// Four emergency-notification writes wrapped their insert in try/catch and
// logged from the catch — a Guardian escalation, a Guardian screening call, an
// urgent Contact Center message and an urgent voicemail. Same reason as above:
// the insert resolves with { data, error }, so the catch never saw a refused
// write and the family simply did not get told.
//
// The escalation route was worse than silent. It set `pushSent = true` on the
// line after the insert, INSIDE the try — so a failed write still marked the
// push as sent, and `push_sent: pushSent` is written into the
// guardian_escalations row and returned to the caller. An emergency was
// permanently recorded as having alerted the parents when nothing was written.
describe('an emergency notification that was not written says so', () => {
  // The two Guardian routes still write the row inline. The two Contact Center
  // ones no longer write it at all: on this branch the urgent path goes through
  // captureInboundWithUrgency/attemptUrgentDelivery, and the notification write
  // lives in lib/contact-center/urgent-delivery.ts. The invariant follows the
  // write rather than being dropped with the line that used to carry it — and it
  // is checked harder there, because that implementation does more than log.
  const ROUTES = [
    'app/api/guardian/escalate/route.ts',
    'app/api/guardian/screen/route.ts',
  ];

  // Whoever writes it, nobody may write it silently.
  const URGENT_DELIVERY = 'lib/contact-center/urgent-delivery.ts';
  const CONTACT_ROUTES = [
    'app/api/contact-center/sms/route.ts',
    'app/api/contact-center/voice/transcription/route.ts',
  ];

  it.each(ROUTES)('%s takes the error from its notifications insert', async (file) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(file, 'utf8');
    const takesError = /const \{[^}]*\berror[^}]*\} = await [\w.]*\.from\('notifications'\)\.insert/.test(source);
    expect(takesError, 'the insert result is discarded, so a refused write is invisible').toBe(true);
  });

  it.each(CONTACT_ROUTES)('%s has no silent inline notifications insert left', async (file) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(file, 'utf8');
    // Either it does not write the row, or it reads the outcome. What it may
    // never do is insert and walk away.
    for (const match of source.matchAll(/await [\w.]*\.from\('notifications'\)\.insert/g)) {
      const line = source.slice(0, match.index).split('\n').length;
      const prefix = source.slice(0, match.index!).split('\n').pop() ?? '';
      expect(/const \{[^}]*\berror[^}]*\} = $/.test(prefix),
        `${file}:${line} inserts a notification and discards the result`).toBe(true);
    }
  });

  it(`${URGENT_DELIVERY} refuses to let a failed urgent notification pass as sent`, async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(URGENT_DELIVERY, 'utf8');
    // Stronger than the routes it replaced. Those logged; this throws, which
    // leaves notificationDone false, which makes attemptUrgentDelivery answer
    // 'failed', which makes both routes answer 503 so the provider retries.
    expect(source).toMatch(/if \(saved\.error\) throw new Error\('Urgent notification write failed'\);/);
    expect(source, 'a write nobody reads back is a write nobody can trust')
      .toMatch(/if \(found\.error[\s\S]{0,300}throw new Error\('Urgent notification identity invalid'\);/);
    expect(source).toMatch(/if \(!notificationDone\) return 'failed';/);
  });

  it.each(CONTACT_ROUTES)('%s turns a failed urgent delivery into a retry, not a 200', async (file) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('attemptUrgentDelivery');
    expect(source, 'answering 200 tells the provider it was handled and there is no second chance')
      .toMatch(/if \(urgentOutcome === 'failed'\) return new NextResponse\([^)]*status: 503/);
  });

  it('the escalation claims a push only when the row landed', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/api/guardian/escalate/route.ts', 'utf8');
    // `pushSent = true` must sit on the no-error branch, never as the next
    // statement after an insert whose outcome nobody checked.
    expect(source).toMatch(/if \(notifyError\)[\s\S]{0,200}else pushSent = true;/);
    expect(source, 'push_sent is persisted, so it has to mean the write landed')
      .toContain('push_sent: pushSent');
  });
});

// audit_logs has the same shape as wallet_audit_logs and the same helper. Three
// call sites wrote it longhand and discarded the error, which the wallet-only
// sweep above could not see.
describe('no audit_logs write discards its error', () => {
  it('leaves no call site inserting the row without reading the outcome', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '.git', '.claude', 'mobile'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
      }
      return out;
    };
    // Longhand is fine where the error is READ — lib/ai/runs/controls.ts and
    // lib/services/activity/index.ts both destructure it and act on it, and
    // both carry table-specific context logAudit does not model. What must not
    // come back is the shape that started this: an awaited insert whose result
    // goes nowhere, so the pattern requires `await` with nothing destructured
    // in front of it.
    const discards = /(?:^|\n)\s*await\s+[\w.]*\.from\(\s*'audit_logs'\s*\)\s*\.insert/;
    const offenders = [...walk('app'), ...walk('lib')]
      .filter((file) => discards.test(readFileSync(file, 'utf8')));
    expect(offenders, 'read the error — use logAudit, or destructure it here').toEqual([]);
  });
});
