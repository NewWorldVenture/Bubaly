// M24 — the Trust Center's Activity tab: what Bubaly did, what it may do, and
// what it was allowed to read.
//
// Three invariants, and they are the whole reason the tab exists:
//
//   1. A FAILED READ IS LOUD. The tab's claim is "here is everything Bubaly
//      did". Rendering that as an empty ledger because a query failed is worse
//      than rendering nothing, so every read returns its error and logs it.
//   2. NAMES, NEVER PAYLOAD. `ai_request_context.snapshot` holds the assembled
//      rows — budgets, document titles, a schedule. Only the slice NAMES may
//      leave the loader, on the tab and on an approval card's "Based on".
//   3. SENSITIVE ROWS ARE MANAGER-ONLY. A child does not get the high-stakes
//      half of the ledger, and does not get the read/withheld history at all —
//      and the page says how many rows are hidden rather than showing a
//      shorter ledger as if it were complete.
import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { expectSays } from './helpers/translated';
import {
  domainForTool, isSensitiveToolCall, loadApprovalBasedOn, loadTrustActivity, sliceNamesOf,
} from '@/lib/trust/activity';

type Reply = { data: unknown; error: unknown };

/**
 * A PostgREST-shaped stub: every builder method chains, and the chain resolves
 * to the reply scripted for that table (await, `.limit()` or `.maybeSingle()`).
 */
function fakeDb(replies: Record<string, Reply>): SupabaseClient<Database> {
  const chainFor = (table: string) => {
    const reply = replies[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'is', 'gt', 'neq']) {
      chain[method] = () => chain;
    }
    chain.limit = () => Promise.resolve(reply);
    chain.maybeSingle = () => Promise.resolve(reply);
    chain.then = (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(reply).then(resolve, reject);
    return chain;
  };
  return { from: (table: string) => chainFor(table) } as unknown as SupabaseClient<Database>;
}

function scopeFor(db: SupabaseClient<Database>, role: ServiceScope['role']): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'user-1',
    memberId: 'member-1',
    role,
    actorKind: 'member',
    tz: 'America/New_York',
  } as ServiceScope;
}

const TOOL_CALL = {
  id: 'call-1',
  tool_name: 'calendar.createEvent',
  state: 'succeeded',
  actor_kind: 'ai',
  run_id: 'run-9',
  request_id: 'req-1',
  duration_ms: 420,
  error: null,
  created_at: '2026-09-05T10:00:00Z',
  finished_at: '2026-09-05T10:00:01Z',
};

const MONEY_CALL = { ...TOOL_CALL, id: 'call-2', tool_name: 'finances.updateBudget', run_id: 'run-8' };

// The snapshot as the context builder persists it: the slice NAMES key an
// object whose values are the family's actual rows.
const SNAPSHOT = {
  intent: 'plan_meals',
  header: { familyName: 'The Hughens' },
  slices: {
    food: { allergies: ['peanuts'], likes: ['tacos'] },
    schedule: { events: [{ title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' }] },
  },
};

function repliesWith(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    ai_tool_calls: { data: [TOOL_CALL, MONEY_CALL], error: null },
    family_ai_settings: {
      data: { family_id: 'fam-1', enabled: true, behavior: 'execute', category_behavior: { finances: 'recommend' } },
      error: null,
    },
    ai_request_context: {
      data: [{ request_id: 'req-1', sensitive_omitted: ['money', 'documents'], snapshot: SNAPSHOT, created_at: '2026-09-05T09:59:00Z' }],
      error: null,
    },
    ai_requests: {
      data: [{ id: 'req-1', request_text: 'Plan meals for next week', interpreted_intent: 'plan_meals' }],
      error: null,
    },
    ...overrides,
  };
}

describe('loadTrustActivity read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails closed and logs when the tool-call ledger read fails — never an empty ledger', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith({ ai_tool_calls: { data: null, error: { message: 'permission denied for table ai_tool_calls' } } }));

    const res = await loadTrustActivity(scopeFor(db, 'parent'));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.retryable).toBe(true);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[ai/runs] tool-call ledger read failed');
  });

  it('fails closed and logs when the autonomy dial read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith({ family_ai_settings: { data: null, error: { message: 'connection reset' } } }));

    const res = await loadTrustActivity(scopeFor(db, 'parent'));

    expect(res.ok).toBe(false);
    // A dropped settings read would render the DEFAULT dials — "Bubaly may
    // execute" for a family that had turned it down to Recommend.
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[trust/activity] autonomy dial read failed');
  });

  it('fails closed and logs when the request-context read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith({ ai_request_context: { data: null, error: { message: 'timeout' } } }));

    const res = await loadTrustActivity(scopeFor(db, 'parent'));

    expect(res.ok).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[trust/activity] request context read failed');
  });

  it('fails closed when the requests behind the context rows cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith({ ai_requests: { data: null, error: { message: 'timeout' } } }));

    const res = await loadTrustActivity(scopeFor(db, 'parent'));

    expect(res.ok).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[trust/activity] request read failed');
  });

  it('gives a manager the ledger with run links, the dials, and slice NAMES only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith());

    const res = await loadTrustActivity(scopeFor(db, 'parent'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.toolCalls.map((c) => c.toolName)).toEqual(['calendar.createEvent', 'finances.updateBudget']);
    expect(res.data.toolCalls[0]).toMatchObject({ domain: 'calendar', runId: 'run-9', state: 'succeeded' });
    expect(res.data.hiddenToolCalls).toBe(0);

    // The dial the family actually set, and the ones that follow the default.
    const money = res.data.dials.categories.find((d) => d.domain === 'finances');
    expect(money).toMatchObject({ behavior: 'recommend', inherited: false });
    expect(res.data.dials.categories.find((d) => d.domain === 'calendar')).toMatchObject({ behavior: 'execute', inherited: true });
    expect(res.data.dials.enabled).toBe(true);

    // Names read and names withheld — and NOT one byte of the snapshot.
    expect(res.data.canSeeContext).toBe(true);
    expect(res.data.contextReads).toEqual([
      {
        requestId: 'req-1',
        requestText: 'Plan meals for next week',
        intent: 'plan_meals',
        createdAt: '2026-09-05T09:59:00Z',
        read: ['food', 'schedule'],
        withheld: ['money', 'documents'],
      },
    ]);
    const serialised = JSON.stringify(res.data);
    expect(serialised).not.toContain('peanuts');
    expect(serialised).not.toContain('Soccer');
    expect(serialised).not.toContain('allergies');
    expect(err).not.toHaveBeenCalled();
  });

  it('hides high-stakes rows from a child, counts them, and never reads the context at all', async () => {
    const db = fakeDb(repliesWith());

    const res = await loadTrustActivity(scopeFor(db, 'child'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The money call is gone, the calendar call stays, and the count says so —
    // a shorter ledger presented as complete would be the lie.
    expect(res.data.toolCalls.map((c) => c.toolName)).toEqual(['calendar.createEvent']);
    expect(res.data.hiddenToolCalls).toBe(1);
    expect(res.data.canSeeContext).toBe(false);
    expect(res.data.contextReads).toEqual([]);
  });
});

describe('approval "Based on"', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns slice names per request for a manager', async () => {
    const db = fakeDb(repliesWith());

    const res = await loadApprovalBasedOn(scopeFor(db, 'adult'), ['req-1', null, 'req-1']);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ 'req-1': { read: ['food', 'schedule'], withheld: ['money', 'documents'] } });
  });

  it('returns nothing for a non-manager, without reading the context table', async () => {
    let touched = false;
    const db = { from: () => { touched = true; return {}; } } as unknown as SupabaseClient<Database>;

    const res = await loadApprovalBasedOn(scopeFor(db, 'child'), ['req-1']);

    expect(res).toEqual({ ok: true, data: {} });
    expect(touched).toBe(false);
  });

  it('fails closed and logs when the context read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb(repliesWith({ ai_request_context: { data: null, error: { message: 'permission denied' } } }));

    const res = await loadApprovalBasedOn(scopeFor(db, 'parent'), ['req-1']);

    expect(res.ok).toBe(false);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[trust/activity] approval context read failed');
  });
});

describe('classification helpers', () => {
  it('reads a tool’s domain from the registry, and treats an unknown tool as sensitive', () => {
    expect(domainForTool('calendar.createEvent')).toBe('calendar');
    expect(domainForTool('finances.updateBudget')).toBe('finances');
    expect(domainForTool('nonsense.doThing')).toBeNull();

    expect(isSensitiveToolCall('finances.updateBudget')).toBe(true);
    expect(isSensitiveToolCall('documents.readDocument')).toBe(true);
    expect(isSensitiveToolCall('calendar.createEvent')).toBe(false);
    // Fail closed: a call nobody can classify is not assumed harmless.
    expect(isSensitiveToolCall('nonsense.doThing')).toBe(true);
  });

  it('takes only the slice names out of a snapshot, whatever shape it is', () => {
    expect(sliceNamesOf(SNAPSHOT)).toEqual(['food', 'schedule']);
    expect(sliceNamesOf({ slices: null })).toEqual([]);
    expect(sliceNamesOf('not an object')).toEqual([]);
    expect(sliceNamesOf(null)).toEqual([]);
  });
});

describe('the Activity tab renders what was read, and says so when it could not', () => {
  it('shows the ledger, the dials beside their policies, and the read/withheld names', async () => {
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
    const React = (await import('react')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { TrustActivityTab } = await import('@/components/modules/trust-activity-tab');

    const html = renderToStaticMarkup(React.createElement(TrustActivityTab, {
      error: null,
      policies: [{ domain: 'finances', enabled: true }],
      activity: {
        toolCalls: [{
          id: 'call-1', toolName: 'calendar.createEvent', domain: 'calendar', state: 'succeeded',
          actorKind: 'ai', createdAt: '2026-09-05T10:00:00Z', durationMs: 420, error: null, runId: 'run-9',
        }],
        hiddenToolCalls: 2,
        dials: {
          enabled: true,
          defaultBehavior: 'execute',
          categories: [{ domain: 'finances', behavior: 'recommend', inherited: false }],
        },
        contextReads: [{
          requestId: 'req-1', requestText: 'Plan meals for next week', intent: 'plan_meals',
          createdAt: '2026-09-05T09:59:00Z', read: ['food'], withheld: ['money'],
        }],
        canSeeContext: true,
      },
    }));

    expect(html).toContain('calendar.createEvent');
    expect(html).toContain('/dashboard/concierge/runs/run-9');
    expect(html).toContain('Open run');
    expect(html).toContain('2 more entries are only shown to parents and adults.');
    expect(html).toContain('Recommend');
    expect(html).toContain('1 policy');
    expect(html).toContain('Food and allergies');
    expect(html).toContain('Budgets and bills');
    expect(html).toContain('Plan meals for next week');
    vi.doUnmock('next/navigation');
  });

  it('renders the retryable failure instead of an empty ledger', async () => {
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
    const React = (await import('react')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { TrustActivityTab } = await import('@/components/modules/trust-activity-tab');

    const html = renderToStaticMarkup(React.createElement(TrustActivityTab, {
      error: 'Could not load what Bubaly has done from Supabase. Refresh and try again.',
      policies: [],
      activity: null,
    }));

    expect(html).toContain('Could not load what Bubaly has done');
    expect(html).toContain('Try again');
    // Not one word that would read as "nothing has happened".
    expect(html).not.toContain('What Bubaly did');
    vi.doUnmock('next/navigation');
  });
});

describe('trust page and Activity tab wiring', () => {
  const page = fs.readFileSync('app/(app)/dashboard/trust/page.tsx', 'utf8');
  const tab = fs.readFileSync('components/modules/trust-activity-tab.tsx', 'utf8');

  it('loads the activity beside the security-state reads and hands the tab a translated failure', () => {
    expect(page).toContain('loadTrustActivity(scope)');
    expect(page).toContain('activity: activityRes.ok ? activityRes.data : null,');
    expectSays(page, 'trustActivity.couldNotLoadActivity', 'Could not load what Bubaly has done from Supabase. Refresh and try again.');
  });

  it('keeps the activity read OUT of the page-wide fail-closed set, so a broken ledger cannot blank the permissions console', () => {
    expect(page).toContain('const trustError = [membersRes.error, policiesRes.error, grantsRes.error, delegationsRes.error, approvalsRes.error, emergenciesRes.error]');
    expect(page).not.toContain('activityRes.error');
  });

  it('renders the retryable error state rather than an empty ledger', () => {
    expect(tab).toContain('if (error || !activity) {');
    expect(tab).toContain('<ErrorState message={error ?? tr(\'trustActivity.couldNotLoadActivity\')} onRetry={() => router.refresh()} />');
  });

  it('links each recorded call to its run', () => {
    expect(tab).toContain('href={`/dashboard/concierge/runs/${call.runId}`}');
  });
});
