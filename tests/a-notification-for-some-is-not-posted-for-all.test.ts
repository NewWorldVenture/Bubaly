// A notification Bubaly sends to some people is not posted for everyone.
//
// `notifications.notify` can address the whole family, the parents, or named
// members. The rows `notify()` writes are per recipient, and `notif_select`
// (0118) lets a member read only a row addressed to them (or a NULL-user
// family row). But the executor then records the tool's summary — "Told 2
// people: <title>" — as the `agent_activity` line, and that table is every
// member's (0127: select on is_family_member), listed to all of them on the
// agents page and in the briefings.
//
// So "let the grown-ups know the custody hearing moved to Friday" reached the
// parents' phones and, word for word, every child's activity feed. The line
// the feed keeps for a narrower audience names who was told, not what.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
const sent = vi.hoisted(() => ({ calls: [] as Array<{ recipients: unknown; title: string }> }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

// The notification rows themselves are notify()'s business and are covered by
// its own tests; here it only has to say how many people it reached.
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: async (_scope: ServiceScope, input: { recipients: unknown; title: string }) => {
    sent.calls.push({ recipients: input.recipients, title: input.title });
    const created = input.recipients === 'family' ? 4 : Array.isArray(input.recipients) ? input.recipients.length : 2;
    return { ok: true, data: { created, ids: [], duplicates: 0, skippedMemberIds: [], deferred: 0 } };
  },
}));

const { executeTool } = await import('@/lib/ai/tools/execute');

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/** Chainable PostgREST fake; every builder is thenable so both terminal styles resolve. */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain, contains: chain, abortSignal: chain,
      eq: filter, is: filter, in: filter, lt: filter, lte: filter, gt: filter, gte: filter, neq: filter, not: filter,
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply & { count?: number }) => void) => { const r = respond(call); resolve(Array.isArray(r.data) ? { ...r, count: r.data.length } : r); },
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

/** The service-role ledger: an `ai_tool_calls` that remembers what it was given. */
function makeLedger() {
  const rows: Array<Record<string, unknown> & { id: string }> = [];
  let counter = 0;
  return makeDb((call) => {
    if (call.table !== 'ai_tool_calls') return { data: null, error: null };
    if (call.kind === 'insert') {
      const row = { ...(call.payload as Record<string, unknown>), id: `call-${++counter}` };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (call.kind === 'select') return { data: null, error: null };
    if (call.kind === 'update') {
      const row = rows.find((r) => r.id === call.filters.id);
      if (row) Object.assign(row, call.payload as Record<string, unknown>);
      return { data: row ? { id: row.id } : null, error: null };
    }
    return { data: null, error: null };
  });
}

/** The caller's client: the household lets Bubaly send messages without asking. */
function makeFamilyDb() {
  return makeDb((call) => {
    switch (call.table) {
      case 'trust_policies': return {
        data: [{
          id: 'pol-msg', domain: 'messaging', capability: 'all', subject_kind: 'ai',
          effect: 'allow', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
        }],
        error: null,
      };
      case 'permission_grants':
      case 'trust_delegations':
      case 'emergency_sessions': return { data: [], error: null };
      case 'approval_requests': return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
      case 'agent_activity': return { data: { id: 'activity-1' }, error: null };
      default: return { data: null, error: null };
    }
  });
}

const NOW = new Date('2026-09-05T12:00:00Z');
const PRIVATE_TITLE = 'Custody hearing moved to Friday';

function parentAsksBubaly(db: SupabaseClient<Database>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-parent', memberId: 'member-parent', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW };
}

async function notifyAs(args: Record<string, unknown>) {
  const family = makeFamilyDb();
  ledgerHolder.client = makeLedger().db;
  const outcome = await executeTool(parentAsksBubaly(family.db), 'notifications.notify', args);
  const feed = family.calls.filter((c) => c.table === 'agent_activity' && c.kind === 'insert').map((c) => c.payload as Record<string, unknown>);
  const trail = family.calls.filter((c) => c.table === 'audit_logs' && c.kind === 'insert').map((c) => c.payload as Record<string, unknown>);
  return { outcome, feed, trail };
}

beforeEach(() => { sent.calls = []; });

describe('the two audiences, as the migrations state them', () => {
  it('a notification row is its recipient\'s; the activity feed is every member\'s', () => {
    const notifications = readFileSync('supabase/migrations/0118_rls_drift_repair.sql', 'utf8');
    expect(notifications).toMatch(/create policy notif_select on public\.notifications for select\s+using \(user_id = auth\.uid\(\) or \(user_id is null and public\.is_family_member\(family_id\)\)\);/);
    const activity = readFileSync('supabase/migrations/0127_agent_activity.sql', 'utf8');
    expect(activity).toMatch(/foreach t in array array\['agent_activity'\]/);
    expect(activity).toContain("for select using (public.is_family_member(family_id))");
  });
});

describe('notifications.notify, run by Bubaly for a parent', () => {
  it('tells only the parents, and the family feed does not repeat what they were told', async () => {
    const { outcome, feed, trail } = await notifyAs({ title: PRIVATE_TITLE, audience: 'managers' });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(sent.calls).toEqual([{ recipients: 'managers', title: PRIVATE_TITLE }]);
    // The parent who asked still reads what was sent.
    expect(outcome.status === 'ok' && outcome.summary).toContain(PRIVATE_TITLE);
    expect(feed).toHaveLength(1);
    expect(JSON.stringify(feed)).not.toContain('Custody');
    expect(feed[0].title).toBe('Sent the parents a notification');
    expect(JSON.stringify(trail)).not.toContain('Custody');
  });

  it('tells named members, and the feed says how many, not what', async () => {
    const { outcome, feed } = await notifyAs({ title: PRIVATE_TITLE, member_ids: ['member-alex'] });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(sent.calls).toEqual([{ recipients: ['member-alex'], title: PRIVATE_TITLE }]);
    expect(JSON.stringify(feed)).not.toContain('Custody');
    expect(feed[0].title).toBe('Sent 1 person a notification');
  });

  it('still names a notice the whole family was sent, since everyone already has it', async () => {
    const { outcome, feed } = await notifyAs({ title: 'Dinner is at 6', audience: 'family' });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(sent.calls).toEqual([{ recipients: 'family', title: 'Dinner is at 6' }]);
    expect(feed[0].title).toBe('Told 4 people: Dinner is at 6');
  });
});
