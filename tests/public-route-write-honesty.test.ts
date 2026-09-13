// Pass F. Two more places that told someone something a discarded result could
// not support — both on routes the earlier sweeps could not see.
//
//   /api/blog/unsubscribe   redirected to "You've been unsubscribed from blog
//                           updates" after an update nobody checked, and
//                           reported a REFUSED LOOKUP as `invalid` — a real
//                           subscriber, holding a real link, told their link
//                           was wrong.
//
//   activateEmergencyAction discarded the trust_audit_logs insert that is the
//                           only record of who turned emergency mode on. That
//                           elevation outranks every deny, policy and risk tier.
//
// Both survived Pass C for the same mechanical reason, which is recorded in
// tests/claimed-writes-that-did-not-land.test.ts: its sweep matched
// `.from('t')` only on the same line as the `await`, and both of these break the
// chain across lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));

const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClient(),
  createServer: async () => createServiceClient(),
}));

/** A blog_subscribers table that answers the lookup and the update as told. */
function subscriberClient(
  lookup: { data: { id: string; status: string } | null; error: unknown },
  updateError: unknown = null,
) {
  const updates: string[] = [];
  const from = () => {
    let mode: 'select' | 'update' = 'select';
    let id = '';
    const chain: Record<string, unknown> = {
      select: () => { mode = 'select'; return chain; },
      update: () => { mode = 'update'; return chain; },
      eq: (_c: string, v: unknown) => { id = String(v); return chain; },
      maybeSingle: () => Promise.resolve(lookup),
      then: (onF: (v: unknown) => unknown) => {
        if (mode === 'update') updates.push(id);
        return Promise.resolve({ data: null, error: updateError }).then(onF);
      },
    };
    return chain;
  };
  return { client: { from }, updates };
}

const TOKEN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const call = async (token: string) => {
  const { GET } = await import('@/app/api/blog/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`https://bubaly.com/api/blog/unsubscribe?token=${token}`));
};
/** The `unsubscribed=` value the reader is redirected to. */
const outcome = (res: { headers: Headers }) =>
  new URL(res.headers.get('location') ?? '').searchParams.get('unsubscribed');

describe('the blog unsubscribe says only what it can support', () => {
  beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('confirms the unsubscribe when the write lands', async () => {
    const { client, updates } = subscriberClient({ data: { id: 'sub-1', status: 'active' }, error: null });
    createServiceClient.mockReturnValue(client);

    expect(outcome(await call(TOKEN))).toBe('1');
    expect(updates).toEqual(['sub-1']);
  });

  it('does NOT confirm when the write is refused', async () => {
    // The defect: the reader was told they were unsubscribed over a row that
    // still said subscribed, and the next digest goes out to them.
    const { client } = subscriberClient(
      { data: { id: 'sub-1', status: 'active' }, error: null },
      { message: 'permission denied for table blog_subscribers' },
    );
    createServiceClient.mockReturnValue(client);

    expect(outcome(await call(TOKEN)), 'promised an unsubscribe that was never written').toBe('error');
  });

  it('does not blame the reader when the LOOKUP is refused', async () => {
    // `invalid` accuses the link. A failed read is not the link's fault, and the
    // two were indistinguishable while the error was discarded.
    const { client } = subscriberClient({ data: null, error: { message: 'connection reset' } });
    createServiceClient.mockReturnValue(client);

    expect(outcome(await call(TOKEN))).toBe('error');
  });

  it('still reports a genuinely unknown token as invalid', async () => {
    const { client } = subscriberClient({ data: null, error: null });
    createServiceClient.mockReturnValue(client);

    expect(outcome(await call(TOKEN))).toBe('invalid');
  });

  it('rejects a malformed token before touching the database', async () => {
    createServiceClient.mockImplementation(() => { throw new Error('must not be reached'); });
    expect(outcome(await call('not-a-uuid'))).toBe('invalid');
  });

  it('does not re-write a subscriber who already unsubscribed', async () => {
    const { client, updates } = subscriberClient({ data: { id: 'sub-1', status: 'unsubscribed' }, error: null });
    createServiceClient.mockReturnValue(client);

    expect(outcome(await call(TOKEN))).toBe('1');
    expect(updates, 'idempotent — unsubscribing twice is still unsubscribed').toEqual([]);
  });

  it('the page can render the third outcome it is now sent', async () => {
    // A route that redirects to a state the page cannot show has moved the
    // problem rather than fixed it.
    const page = readFileSync('app/(marketing)/blog/page.tsx', 'utf8');
    expect(page).toContain("params.unsubscribed === 'error'");
    expect(page).toMatch(/you may still receive blog emails/i);
  });
});

describe('activating emergency mode is recorded, or the failure is', () => {
  it('reads the audit insert and names what was lost', () => {
    const source = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');
    expect(source).toMatch(/const \{ error: auditError \} = await \(await ledgerWriter\(supabase\)\)\.from\('trust_audit_logs'\)\.insert/);
    expect(source).toMatch(/emergency mode was activated but not recorded/);
    // It has to say WHICH family and WHO, since the row it replaces is the only
    // record of who holds an elevation that outranks every deny.
    expect(source).toMatch(/activatedBy: ctx\.active\.member\.id/);

    // And it must NOT fail the action: emergency_sessions already inserted, so
    // the elevation is live. Telling a parent mid-emergency that it failed
    // invites them to activate it twice.
    const block = source.slice(source.indexOf('if (auditError)'));
    expect(block.slice(0, block.indexOf('\n  }')), 'a failed log line must not fail a live emergency')
      .not.toContain('throw');
  });
});
