import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// #892 comment 5973332041. What a member typed to the concierge, and their answers
// to its clarifying questions, were readable by every member of the family:
// `ai_requests` is family-readable, and the run page read the request with the
// viewer's session. 0480 withdraws `request_text` and `clarifications` from
// `authenticated` (a member-session `select('*')` is now refused by Postgres)
// and serves them through `ai_request_words` to the requester or a manager.
// The Postgres side is proven by docs/audit/a-request-text-is-its-requesters-check.sql;
// this drives the REAL `loadRunDetail` as three members of one family.

const FAMILY = '00000000-0000-4000-8000-0000000480f0';
const REQUESTER = 'user-teen';
const SIBLING = 'user-child';
const PARENT = 'user-parent';
const WORDS = 'Plan a surprise party for my sister';
const ANSWER = 'Saturday, while she is at practice';

/** One family, one concierge request and its run, as `viewer` sees the database. */
function asViewer(viewer: string) {
  const store = createInMemorySupabase({ userId: viewer });
  store.seed('family_members', [
    { id: 'm-teen', family_id: FAMILY, user_id: REQUESTER, role: 'teen', is_active: true, display_name: 'Teen' },
    { id: 'm-child', family_id: FAMILY, user_id: SIBLING, role: 'child', is_active: true, display_name: 'Child' },
    { id: 'm-parent', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, display_name: 'Parent' },
  ]);
  store.seed('ai_requests', [{ id: 'req-1', family_id: FAMILY, kind: 'concierge', requested_by: REQUESTER, request_text: WORDS, status: 'completed', clarifications: [{ question: 'Which day?', answer: ANSWER }] }]);
  store.seed('family_automation_runs', [{ id: 'run-1', family_id: FAMILY, request_id: 'req-1', plan_id: null, run_type: 'concierge_plan', state: 'completed', status: 'completed', progress: {}, summary: null, created_at: '2026-10-03T10:00:00Z' }]);

  // What the member session asked of ai_requests: Postgres now refuses `*` and `request_text`.
  const selects: string[] = [];
  const client = {
    from: (table: string) => {
      const builder = store.from(table) as unknown as { select: (c?: string, o?: unknown) => unknown };
      if (table !== 'ai_requests') return builder;
      const select = builder.select.bind(builder);
      builder.select = (columns?: string, opts?: unknown) => { selects.push(columns ?? '*'); return select(columns, opts); };
      return builder;
    },
    rpc: (name: string, args: Record<string, unknown>) => store.rpc(name, args),
    auth: store.auth,
  } as unknown as SupabaseClient<Database>;
  return { client, selects };
}

async function openRun(viewer: string, viewerRole: string) {
  const { loadRunDetail, toRunView } = await import('@/lib/ai/runs/detail');
  const { client, selects } = asViewer(viewer);
  const detail = await loadRunDetail(client, FAMILY, 'run-1', { viewerRole: viewerRole as never });
  if (!detail.ok || !detail.data) throw new Error(`the run did not open: ${JSON.stringify(detail)}`);
  return { detail: detail.data, view: toRunView(detail.data, FAMILY, viewerRole === 'parent'), selects };
}

describe('a concierge request\'s words are its requester\'s and a manager\'s (0480)', () => {
  it('the requester sees their own words on the run page', async () => {
    const { detail, view } = await openRun(REQUESTER, 'teen');
    expect(detail.request?.request_text).toBe(WORDS);
    expect(view).toMatchObject({ requestText: WORDS });
    expect(JSON.stringify(view)).toContain(ANSWER);
  });

  it('a parent (manager) sees them too', async () => {
    const { view } = await openRun(PARENT, 'parent');
    expect(view).toMatchObject({ requestText: WORDS });
    expect(JSON.stringify(view)).toContain(ANSWER);
  });

  it('a sibling still opens the run, but not one word of the request', async () => {
    const { detail, view } = await openRun(SIBLING, 'child');
    expect(detail.run.id).toBe('run-1');
    expect(detail.request?.request_text).toBe('');
    expect(view).toMatchObject({ requestText: null, objective: 'Your request' });
    expect(JSON.stringify(view)).not.toContain('surprise');
    expect(JSON.stringify(view)).not.toContain('practice');
    expect(detail.request?.clarifications).toEqual([]);
  });

  it('no member read selects request_text, clarifications or `*` (refused by Postgres after 0480)', async () => {
    for (const [viewer, role] of [[REQUESTER, 'teen'], [SIBLING, 'child'], [PARENT, 'parent']] as const) {
      const { selects } = await openRun(viewer, role);
      expect(selects.length).toBeGreaterThan(0);
      for (const columns of selects) {
        expect(columns).not.toBe('*');
        const named = columns.split(',').map((c) => c.trim());
        expect(named).not.toContain('request_text');
        expect(named).not.toContain('clarifications');
      }
    }
  });
});
