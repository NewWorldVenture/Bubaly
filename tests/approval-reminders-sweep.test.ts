// `remindPendingApprovals` is the cron half of the reminder: it fans the pure
// builder out through the notifications service, once per (approval, manager),
// and must stay silent on the next tick — even after the manager has read the
// first reminder — because "one reminder per pending AI approval" is the promise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const holder = vi.hoisted(() => ({ service: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => undefined, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({ executeTool: async () => ({ status: 'denied', reason: 'not in this test', toolCallId: null }) }));

const { remindPendingApprovals } = await import('@/lib/services/approvals');

type Call = { table: string; kind: 'select' | 'insert' | 'update'; filters: Record<string, unknown>; payload?: unknown };
type Row = Record<string, unknown> & { id: string };

function makeStore(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls: Call[] = [];
  let counter = 0;
  const matches = (row: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, value]) => {
      if (key.startsWith('in:')) return (value as unknown[]).includes(row[key.slice(3)]);
      if (key.startsWith('or:') || key.startsWith('gt:') || key.startsWith('lt:')) return true;
      return row[key] === value;
    });
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const resolve = () => {
      const rows = tables[table] ?? (tables[table] = []);
      if (call.kind === 'insert') {
        const payloads = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
        const inserted = payloads.map((p) => ({ ...p, id: p.id ?? `${table}-${++counter}` }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (call.kind === 'update') {
        const hit = rows.filter((r) => matches(r, call.filters));
        for (const r of hit) Object.assign(r, call.payload as Record<string, unknown>);
        return { data: hit, error: null };
      }
      return { data: rows.filter((r) => matches(r, call.filters)), error: null };
    };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: (expr: string) => filter(`or:${expr}`, true),
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      maybeSingle: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      then: (onFulfilled: (value: { data: unknown; error: null }) => void) => onFulfilled(resolve()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls, tables };
}

const NOW = new Date('2026-09-05T12:00:00Z');

const seed = () => ({
  approval_requests: [
    { id: 'appr-1', family_id: 'fam-1', status: 'pending', requested_by_kind: 'ai', title: 'Add soccer', amount_cents: null, created_at: 'x', expires_at: '2026-09-07T12:00:00Z', agent: 'concierge' },
    // A member's own request is not an AI approval and gets no reminder here.
    { id: 'appr-2', family_id: 'fam-1', status: 'pending', requested_by_kind: 'member', title: 'Spend $20', amount_cents: 2000, created_at: 'x', expires_at: null, agent: null },
  ],
  families: [{ id: 'fam-1', timezone: 'America/New_York' }],
  family_members: [
    { id: 'm1', family_id: 'fam-1', user_id: 'u1', role: 'parent', is_active: true },
    { id: 'm2', family_id: 'fam-1', user_id: 'u2', role: 'adult', is_active: true },
    { id: 'm3', family_id: 'fam-1', user_id: 'u3', role: 'teen', is_active: true },
  ],
  notifications: [] as Row[],
});

beforeEach(() => { holder.service = null; });

describe('remindPendingApprovals', () => {
  it('notifies each manager once per pending AI approval, never the teen', async () => {
    const store = makeStore(seed());
    holder.service = store.db;
    const result = await remindPendingApprovals(store.db, NOW);
    expect(result).toEqual({ reminded: 2, families: 1 });

    const rows = store.tables.notifications;
    expect(rows.map((r) => r.user_id).sort()).toEqual(['u1', 'u2']);
    expect(rows.map((r) => r.related_id).sort()).toEqual(['ai-approval:appr-1:m1', 'ai-approval:appr-1:m2']);
    expect(rows.every((r) => r.family_id === 'fam-1' && r.type === 'system' && r.related_type === 'approval_requests')).toBe(true);
    expect(rows[0].title).toBe('Needs your OK: Add soccer');
  });

  it('is silent on the next tick even after the reminder was read', async () => {
    const store = makeStore(seed());
    holder.service = store.db;
    await remindPendingApprovals(store.db, NOW);
    for (const row of store.tables.notifications) row.is_read = true;
    const again = await remindPendingApprovals(store.db, new Date(NOW.getTime() + 6 * 3600_000));
    expect(again).toEqual({ reminded: 0, families: 0 });
    expect(store.tables.notifications).toHaveLength(2);
  });

  it('skips a family whose dedupe read fails rather than re-notifying everyone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore(seed());
    const fake = store.db as unknown as { from: (table: string) => unknown };
    const original = fake.from;
    fake.from = (table: string) => {
      const b = original(table) as Record<string, unknown>;
      if (table === 'notifications') {
        b.then = (onFulfilled: (v: { data: null; error: { message: string } }) => void) => onFulfilled({ data: null, error: { message: 'boom' } });
      }
      return b;
    };
    holder.service = store.db;
    expect(await remindPendingApprovals(store.db, NOW)).toEqual({ reminded: 0, families: 0 });
    expect(store.tables.notifications).toHaveLength(0);
    errors.mockRestore();
  });
});
