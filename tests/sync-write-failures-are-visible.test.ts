// The provider-sync half of the discarded-write sweep.
//
// Same root cause as logAudit (see tests/audit-write-failures-are-visible.test.ts):
// a PostgREST call RESOLVES with { data, error } and rejects only under
// .throwOnError(), so `await client.from(t).insert(row)` with the result thrown
// away cannot fail visibly. tsc has nothing to say about it either.
//
// What makes these two tables worth fixing rather than filing as telemetry is
// that both are READ by surfaces people act on:
//
//   sync_audit_logs      → /dashboard/sync/history, the account history a member
//                          is shown. One of its actions is 'disconnect', so the
//                          row most likely to be missed is the one someone looks
//                          for to check whether access was ever taken away.
//   sync_provider_errors → the admin sync page counts it .eq('is_fatal', true).
//                          A silently refused write does not fail safe: it makes
//                          a broken integration look healthier than it is, on the
//                          screen used to decide whether to act.
//
// And one write in this area was not a visibility problem at all. Both disconnect
// routes discarded the result of the DELETE that performs the disconnect, then
// redirected unconditionally to ?disconnected=1 — which renders "Account
// disconnected and access revoked." So a refused delete left the account
// connected, still syncing, and told the member their access had been revoked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { logSyncAudit, logSyncProviderError } from '@/lib/sync/audit';

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

function throwingClient() {
  return { from: () => { throw new Error('client has no URL'); } } as unknown as SupabaseClient<Database>;
}

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); });

const AUDIT_ROW = {
  user_id: '11111111-1111-4111-8111-111111111111',
  family_id: '22222222-2222-4222-8222-222222222222',
  provider: 'google',
  action: 'disconnect',
} as Database['public']['Tables']['sync_audit_logs']['Insert'];

const ERROR_ROW = {
  family_id: '22222222-2222-4222-8222-222222222222',
  provider: 'google',
  code: 'push_task',
  message_redacted: 'redacted',
} as Database['public']['Tables']['sync_provider_errors']['Insert'];

describe('a refused sync write produces output', () => {
  it('logSyncAudit reports an error the insert resolved with', async () => {
    const { client } = resolvingClient({ error: { code: '42501', message: 'permission denied' } });
    await logSyncAudit(client, AUDIT_ROW);
    expect(logged, 'a refused sync audit write produced no output at all').toHaveLength(1);
    expect(String(logged[0][0])).toContain('[sync-audit]');
    // The message has to name what was lost, or a log line is just noise.
    expect(String(logged[0][0])).toContain('disconnect');
    expect(String(logged[0][0])).toContain('google');
  });

  it('logSyncProviderError reports one too', async () => {
    const { client } = resolvingClient({ error: { code: '42501', message: 'permission denied' } });
    await logSyncProviderError(client, ERROR_ROW);
    expect(logged, 'a refused provider-error write produced no output at all').toHaveLength(1);
    expect(String(logged[0][0])).toContain('[sync-error]');
    expect(String(logged[0][0])).toContain('push_task');
  });

  it('stays silent on success', async () => {
    const { client, inserted } = resolvingClient({ error: null });
    await logSyncAudit(client, AUDIT_ROW);
    await logSyncProviderError(client, ERROR_ROW);
    expect(inserted).toHaveLength(2);
    expect(logged).toEqual([]);
  });

  it('still reports a synchronous throw while the query is built', async () => {
    await logSyncAudit(throwingClient(), AUDIT_ROW);
    expect(logged).toHaveLength(1);
  });

  it('never rejects into the caller — the sync already happened', async () => {
    const { client } = resolvingClient({ error: { code: '08006', message: 'connection failure' } });
    await expect(logSyncAudit(client, AUDIT_ROW)).resolves.toBeUndefined();
    await expect(logSyncProviderError(client, ERROR_ROW)).resolves.toBeUndefined();
    await expect(logSyncAudit(throwingClient(), AUDIT_ROW)).resolves.toBeUndefined();
  });
});

// The sweep. Written against the source rather than behaviour because the point
// is that the next call site cannot be written the old way either.
describe('no sync write discards its error', () => {
  // Both of these read the error and do something with it that this helper
  // cannot express. Routing them through it would quietly drop that, so they are
  // exempt by name, with the reason, and the reason is checked below.
  const EXEMPT: Record<string, { reason: string; mustContain: string }> = {
    'app/api/cron/provider-sync/route.ts': {
      reason: 'counts audit failures and returns the count in the cron response',
      mustContain: 'auditFailed++',
    },
    'lib/services/onboarding-calendar/oauth.ts': {
      reason: 'throws — onboarding treats a connection with no receipt as failed',
      mustContain: "throw new Error('Calendar connection receipt unavailable')",
    },
  };

  it.each(['sync_audit_logs', 'sync_provider_errors'])(
    'leaves no call site inserting %s longhand outside the helper', async (table) => {
      const { readdirSync } = await import('node:fs');
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', '.next', '.git', '.claude', 'mobile'].includes(entry.name)) continue;
          if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out);
          else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
        }
        return out;
      };
      const files = [...walk('app'), ...walk('lib')];
      expect(files.length, 'the walk found nothing, so it proves nothing').toBeGreaterThan(100);

      const offenders: string[] = [];
      for (const file of files) {
        if (file === 'lib/sync/audit.ts') continue;              // the helper itself
        const rel = file.replace(/^\.\//, '');
        if (EXEMPT[rel]) continue;
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(new RegExp(`await [\\w.]*\\.from\\('${table}'\\)\\.insert`, 'g'))) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}`);
        }
      }
      expect(offenders, `write ${table} through lib/sync/audit.ts, or add a reason`).toEqual([]);
    });

  it.each(Object.entries(EXEMPT))('the exemption for %s still earns itself', (file, { mustContain }) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(mustContain);
    // It must genuinely read the error; an exemption is not a licence to discard.
    expect(source).toMatch(/(const \{[^}]*\berror[^}]*\} = await|\.error\b)/);
  });
});

// The one write here whose failure may not be reported as success.
describe('a disconnect that did not happen is not reported as revoked access', () => {
  const ROUTES = [
    'app/api/sync/[provider]/disconnect/route.ts',
    'app/api/sync/google/disconnect/route.ts',
  ];

  it.each(ROUTES)('%s reads the delete error', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/const \{ error: deleteError \} = await admin\.from\('sync_accounts'\)\.delete\(\)/);
  });

  it.each(ROUTES)('%s redirects to the failure flag instead of falling through', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/if \(deleteError\)/);
    expect(source).toContain('error=disconnect_failed');
    // The failure branch has to RETURN. Logging and continuing would land on
    // ?disconnected=1 anyway, which is the defect wearing a warning label.
    const branch = source.slice(source.indexOf('if (deleteError)'));
    const untilClose = branch.slice(0, branch.indexOf('\n    }'));
    expect(untilClose, 'the failure branch falls through to the success redirect')
      .toContain('return NextResponse.redirect');
    expect(source.indexOf('error=disconnect_failed'))
      .toBeLessThan(source.lastIndexOf('disconnected=1'));
  });

  // Revocation is best effort by design. Claiming it happened is not.
  it('the provider-generic route only claims revocation when revokeToken succeeded', () => {
    const source = readFileSync('app/api/sync/[provider]/disconnect/route.ts', 'utf8');
    // The outcome has to come from the call, not from reaching the end of the
    // function. `.catch(() => {})` discarding it is what made the claim
    // unconditional.
    expect(source).toMatch(/revoked = await adapter\.revokeToken\(refresh\)\.then\(\(\) => true\)\.catch\(\(\) => false\)/);
    expect(source).toMatch(/const outcome = revoked \? 'disconnected=1' : 'disconnected=kept';/);
    // And `revoked` must start false, so the no-adapter and no-refresh-token
    // paths — which revoke nothing at all — fall to the honest message too.
    expect(source).toMatch(/let revoked = false;/);
  });

  it('the page can render the disconnected-but-not-revoked outcome', () => {
    const page = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');
    const entry = page.match(/'disconnected=kept': \{ tone: '(\w+)', text: '([^']+)' \}/);
    expect(entry, 'the route reports an outcome the page cannot render').not.toBeNull();
    // Still a success — the disconnect DID happen — but it must not claim the
    // grant was withdrawn, and it should say what is left to do.
    expect(entry![1]).toBe('success');
    expect(entry![2]).not.toMatch(/access revoked/);
    expect(entry![2]).toMatch(/revoke it there/);
  });

  it('the page says access was NOT revoked, in the danger tone', () => {
    const page = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');
    const entry = page.match(/'error=disconnect_failed': \{ tone: '(\w+)', text: '([^']+)' \}/);
    expect(entry, 'the route reports a flag the page cannot render').not.toBeNull();
    expect(entry![1]).toBe('danger');
    expect(entry![2]).toMatch(/NOT been revoked/);
  });
});
