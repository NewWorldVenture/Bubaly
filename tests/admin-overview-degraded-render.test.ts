import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SOURCE_MESSAGES } from '@/lib/i18n/messages';

// The operator-reported failure, reproduced end to end.
//
// `/admin` returned "Could not load the admin dashboard from Supabase" in
// production. The source-inspection test beside this one (admin-overview-read-
// boundary) asserts the SHAPE of the fix; it cannot prove the page renders,
// because a grep for `loadErrors` passes whether or not React survives the
// render. This actually calls the server component and renders its tree, with
// Supabase failing exactly the way production fails it.
//
// Two failure modes are driven, because they reach the page by different paths:
//   - a RESOLVED { data, error } — what Postgrest returns for a missing table,
//     which is the production case (the ledger stops at 0001-0003)
//   - a REJECTED promise — a transport failure (CONNECT_TIMEOUT on the
//     t4g.nano), which is invisible to `if (res.error)` and, before settleAll,
//     rejected the whole batch and took the route's error boundary with it.

type Mode = 'ok' | 'resolved-error' | 'reject' | 'credential';
let mode: Mode = 'ok';
/** Table names to fail. Empty with mode !== 'ok' means fail everything. */
let failing: string[] = [];

const shouldFail = (table: string) =>
  mode !== 'ok' && (failing.length === 0 || failing.includes(table));

/** A thenable that chains like a Postgrest builder and settles like one. */
function builder(table: string): Record<string, unknown> {
  // Whether this read was issued as `{ count: 'exact', head: true }`. It matters:
  // PostgREST returns NO BODY on a HEAD, so supabase-js has nothing to parse and
  // the resulting error carries an EMPTY message. Reproducing that faithfully is
  // the only way to catch the blank "families (count): " rows.
  let isHeadCount = false;
  const settle = () => {
    if (!shouldFail(table)) return Promise.resolve({ data: [], count: 0, error: null });
    if (mode === 'reject') return Promise.reject(new Error(`CONNECT_TIMEOUT reading ${table}`));
    if (mode === 'credential') {
      return Promise.resolve({
        data: null, count: null,
        error: { message: isHeadCount ? '' : 'Unregistered API key', code: '', details: null, hint: null },
      });
    }
    return Promise.resolve({
      data: null, count: null,
      error: { message: `relation "public.${table}" does not exist` },
    });
  };
  const chain: Record<string, unknown> = {
    then: (...args: unknown[]) => (settle() as Promise<unknown>).then(...(args as [])),
    catch: (...args: unknown[]) => (settle() as Promise<unknown>).catch(...(args as [])),
    finally: (...args: unknown[]) => (settle() as Promise<unknown>).finally(...(args as [])),
  };
  chain.select = (_columns?: unknown, options?: { head?: boolean }) => {
    if (options?.head) isHeadCount = true;
    return chain;
  };
  for (const m of ['eq', 'gte', 'lte', 'in', 'order', 'limit', 'not', 'is', 'neq', 'or', 'range', 'single', 'maybeSingle']) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (table: string) => builder(table) }),
}));

vi.mock('@/lib/server/health', () => ({
  checkDatabase: async () => ({ name: 'db', ok: false, latencyMs: null, detail: 'unreachable' }),
  checkStorage: async () => ({ name: 'storage', ok: false, latencyMs: null, detail: 'unreachable' }),
  checkEmail: () => ({ name: 'email', ok: true, latencyMs: null, detail: 'Configured' }),
  checkAI: () => ({ name: 'ai', ok: true, latencyMs: null, detail: 'Configured' }),
}));

// Real English, so the assertions below are the words an operator reads.
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => SOURCE_MESSAGES[key] ?? key,
}));

const ERROR_STATE_COPY = 'Could not load the admin dashboard from Supabase';

async function render(): Promise<string> {
  const { default: AdminDashboardPage } = await import('@/app/(app)/admin/page');
  return renderToStaticMarkup(await AdminDashboardPage());
}

describe('/admin renders when its reads fail', () => {
  beforeEach(() => { mode = 'ok'; failing = []; });

  it('renders the dashboard when every read succeeds', async () => {
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).not.toContain(ERROR_STATE_COPY);
    // No banner when nothing failed.
    expect(html).not.toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
  });

  it('renders, and names the table, when one read returns an error', async () => {
    mode = 'resolved-error';
    failing = ['admin_notifications'];
    const html = await render();

    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).not.toContain(ERROR_STATE_COPY);
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    // Named specifically — "something failed" would not tell an operator where to look.
    expect(html).toContain('relation &quot;public.admin_notifications&quot; does not exist');
    // The eleven healthy reads still rendered their tiles.
    expect(html).toContain(SOURCE_MESSAGES['admin.totalFamilies']);
    expect(html).toContain(SOURCE_MESSAGES['admin.monthlyRevenue']);
  });

  it('renders when EVERY read returns an error', async () => {
    mode = 'resolved-error';
    const html = await render();

    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).not.toContain(ERROR_STATE_COPY);
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    // All twelve batched reads are listed, so no failure is hidden behind another.
    for (const label of [
      'families (count)', 'active members (count)', 'active subscriptions (count)',
      'families:', 'active members:', 'subscriptions:', 'documents:', 'new members:',
      'recent audit logs', 'support tickets', 'admin notifications',
      'unread notifications (count)',
    ]) expect(html).toContain(label);
  });

  it('renders when the reads REJECT — the transport failure, not a query error', async () => {
    mode = 'reject';
    const html = await render();

    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).not.toContain(ERROR_STATE_COPY);
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(html).toContain('CONNECT_TIMEOUT reading families');
  });

  it('never throws — a throw here is the route error boundary, not a banner', async () => {
    for (const m of ['ok', 'resolved-error', 'reject', 'credential'] as const) {
      mode = m;
      await expect(render()).resolves.toBeTypeOf('string');
    }
  });
});

// The state production was actually in on 2026-09-07, once the page rendered far
// enough to say so: the anon key worked (so /api/health reported a healthy `ok`)
// while the SERVICE-ROLE key was rejected, and every read on /admin failed with
// the same opaque string.
describe('/admin when Supabase rejects the service-role key', () => {
  beforeEach(() => { mode = 'credential'; failing = []; });

  it('gives every failed read a non-blank reason', async () => {
    const html = await render();
    // The defect, stated as the operator saw it: four rows ended at the colon.
    // `<li>families (count): </li>` — the reason simply absent.
    expect(html).not.toMatch(/<li>[^<]*:\s*<\/li>/);
  });

  it('names the count reads, whose HEAD response carries no message at all', async () => {
    const html = await render();
    for (const label of [
      'families (count)', 'active members (count)',
      'active subscriptions (count)', 'unread notifications (count)',
    ]) {
      expect(html).toContain(`${label}: unknown error`);
    }
  });

  it('still reports the reason verbatim where Supabase gave one', async () => {
    const html = await render();
    expect(html).toContain('families: Unregistered API key');
  });

  it('says what to actually do, once, instead of repeating one opaque string', async () => {
    const html = await render();
    expect(html).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(html).toContain('Vercel');
    // The hint is a headline, not a per-row repetition.
    expect(html.match(/SUPABASE_SERVICE_ROLE_KEY/g)).toHaveLength(1);
  });

  it('keeps rendering the dashboard rather than the error state', async () => {
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).not.toContain(ERROR_STATE_COPY);
  });

  it('offers no service-role hint when the failure is an ordinary missing table', async () => {
    mode = 'resolved-error';
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.someDataCouldNotBeLoaded']);
    expect(html).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
