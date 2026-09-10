import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { verifiedAutomaticCaptureShare, type CaptureRecord, type CaptureToolProof } from '@/lib/metric/automatic-capture';
import { loadAutomaticCaptureShare } from '@/lib/metric/automatic-capture-server';
import { executeTool } from '@/lib/ai/tools/execute';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
const FAMILY = 'family-1';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const SINCE = '2026-09-02T12:00:00.000Z';
const captured = (id: string, table: CaptureRecord['table'] = 'calendar_events', extra: Partial<CaptureRecord> = {}): CaptureRecord => ({ id, familyId: FAMILY, table, createdAt: NOW.toISOString(), ...extra });
const proof = (resourceId: string, extra: Partial<CaptureToolProof> = {}): CaptureToolProof => ({
  familyId: FAMILY, toolName: 'calendar.createEvent', state: 'succeeded', actorKind: 'ai', resourceTable: 'calendar_events', resourceId, verified: true, finishedAt: NOW.toISOString(), ...extra,
});
const summarize = (records: CaptureRecord[], tools: CaptureToolProof[] = [], feeds: { id: string; familyId: string }[] = []) => verifiedAutomaticCaptureShare({ familyId: FAMILY, records, tools, feeds, now: NOW });

describe('verified automatic capture definition', () => {
  it('counts canonical records once across duplicate rows, repeated tool proofs and feed proofs', () => {
    const event = captured('event-1', 'calendar_events', { feedId: 'feed-1', externalUid: 'uid-1' });
    const result = summarize([event, event, captured('task-1', 'todo_items'), captured('bill-1', 'bills')], [proof('event-1'), proof('event-1')], [{ id: 'feed-1', familyId: FAMILY }]);
    expect(result).toMatchObject({ total: 3, automatic: 1, unknown: 2, minimumPercent: 33.3, since: SINCE, until: NOW.toISOString() });
  });

  it.each([
    { state: 'failed' }, { state: 'reserved' }, { verified: false }, { actorKind: 'member' },
    { toolName: 'calendar.updateEvent' }, { toolName: 'calendar.deleteEvent' }, { toolName: 'create_calendar_event' },
    { resourceTable: 'todo_items' }, { resourceId: 'different' }, { familyId: 'other-family' },
    { finishedAt: null }, { finishedAt: '2026-09-09T12:00:01.000Z' },
    { finishedAt: '2026-09-01T12:00:00.000Z' },
  ])('leaves an unsupported or unverified proof unknown: %j', (extra) => {
    expect(summarize([captured('event-1')], [proof('event-1', extra)])).toMatchObject({ total: 1, automatic: 0, unknown: 1, minimumPercent: 0 });
  });

  it('requires a real same-family feed and external UID', () => {
    const rows = [
      captured('good', 'calendar_events', { feedId: 'ours', externalUid: 'uid' }),
      captured('foreign', 'calendar_events', { feedId: 'foreign', externalUid: 'uid' }),
      captured('missing', 'calendar_events', { feedId: 'missing', externalUid: 'uid' }),
      captured('blank', 'calendar_events', { feedId: 'ours', externalUid: ' ' }),
    ];
    expect(summarize(rows, [], [{ id: 'ours', familyId: FAMILY }, { id: 'foreign', familyId: 'other-family' }])).toMatchObject({ total: 4, automatic: 1, unknown: 3 });
  });

  it('uses creation time within the fixed seven-day window and excludes other families', () => {
    expect(summarize([
      captured('boundary', 'bills', { createdAt: SINCE }), captured('now'),
      captured('old', 'bills', { createdAt: '2026-09-02T11:59:59.999Z' }),
      captured('future', 'bills', { createdAt: '2026-09-09T12:00:00.001Z' }),
      captured('foreign', 'bills', { familyId: 'other-family' }),
    ])).toMatchObject({ total: 2, automatic: 0, unknown: 2 });
  });

  it('distinguishes no data from a measured zero and never rounds a lower bound upward', () => {
    expect(summarize([])).toMatchObject({ total: 0, minimumPercent: null });
    expect(summarize([captured('unknown')])).toMatchObject({ total: 1, minimumPercent: 0 });
    expect(summarize([captured('a'), captured('b'), captured('c')], [proof('a'), proof('b')]).minimumPercent).toBe(66.6);
  });
});

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']], calendar_events: [['family_id', 'idempotency_key']], todo_items: [['family_id', 'idempotency_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { todo_items: { is_done: false }, family_reminders: { member_id: null } },
  });
  state.db = db;
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, user_id: 'user-1', display_name: 'Parent', role: 'parent' }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Return a PostgREST failure on the selected read, keeping other reads real. */
function readFailure(table: string, at = 1) {
  const original = db.from.bind(db);
  let count = 0;
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = original(name);
    if (name !== table || ++count !== at) return builder;
    const reply = { data: null, error: { message: 'Unavailable' } };
    const chain: Record<string, unknown> = {};
    const proxy = new Proxy(chain, { get: (_target, property) => property === 'then' ? Promise.resolve(reply).then.bind(Promise.resolve(reply)) : () => proxy });
    return proxy;
  }) as typeof db.from);
}

describe('complete capture reads and actual tool provenance', () => {
  it('recognizes canonical creation ledger rows written by actual tools, including aliases and replay', async () => {
    const scope: ServiceScope = { db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'UTC', now: NOW };
    const entries = [
      ['create_calendar_event', { title: 'Practice', starts_at: '2026-09-10T12:00:00Z' }],
      ['add_todo', { title: 'Pack kit' }],
      ['remind_me', { title: 'Bring form', remind_at: '2026-09-10T11:00:00Z' }],
    ] as const;
    for (let i = 0; i < entries.length; i++) {
      const [name, args] = entries[i];
      const options = { skipTrust: true, idempotencyKey: `capture-${i}` };
      const first = await executeTool(scope, name, args, options);
      expect(first).toMatchObject({ status: 'ok' });
      if (first.status !== 'ok') throw new Error('Fixture tool did not create its record');
      expect(await executeTool(scope, name, args, options)).toMatchObject({ status: 'ok', toolCallId: first.toolCallId });
    }
    expect(db.table('ai_tool_calls').map((row) => row.tool_name)).toEqual(['calendar.createEvent', 'tasks.createTodo', 'reminders.create']);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toMatchObject({ ok: true, data: { total: 3, automatic: 3, unknown: 0, minimumPercent: 100 } });
  });

  it('keeps legacy metadata, bills, absent ledger and unrelated families out of automatic proof', async () => {
    db.seed('calendar_events', [{ id: 'event-1', family_id: FAMILY, created_by: 'user-1', feed_id: 'feed-1', external_uid: 'uid' }, { id: 'foreign', family_id: 'other-family', feed_id: 'feed-2', external_uid: 'uid' }]);
    db.seed('calendar_feeds', [{ id: 'feed-1', family_id: FAMILY }, { id: 'feed-2', family_id: 'other-family' }]);
    db.seed('todo_items', [{ id: 'task-1', family_id: FAMILY, created_by: null, idempotency_key: 'legacy-key' }]);
    db.seed('bills', [{ id: 'bill-1', family_id: FAMILY, created_by: 'user-1' }]);
    db.seed('family_reminders', [{ id: 'reminder-1', family_id: FAMILY, ai_suggested: true }]);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toMatchObject({ ok: true, data: { total: 4, automatic: 1, unknown: 3, minimumPercent: 25 } });
  });

  it('reads beyond the first page even when the server caps responses below the requested size', async () => {
    db.seed('bills', Array.from({ length: 405 }, (_, i) => ({ id: `bill-${String(i).padStart(4, '0')}`, family_id: FAMILY })));
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      const builder = original(name);
      const limit = builder.limit.bind(builder);
      vi.spyOn(builder, 'limit').mockImplementation((count) => limit(Math.min(count, 100)));
      return builder;
    }) as typeof db.from);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toMatchObject({ ok: true, data: { total: 405, unknown: 405, automatic: 0 } });
    expect(db.log.filter((read) => read.table === 'bills').length).toBeGreaterThan(4);
  });

  it('does not skip unread records when a prior-page record is deleted between pages', async () => {
    db.seed('bills', Array.from({ length: 5 }, (_, i) => ({ id: `bill-${i}`, family_id: FAMILY })));
    const original = db.from.bind(db);
    let billReads = 0;
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      if (name === 'bills' && ++billReads === 2) {
        db.replace('bills', db.table('bills').filter((row) => row.id !== 'bill-0'));
      }
      const builder = original(name);
      const limit = builder.limit.bind(builder);
      vi.spyOn(builder, 'limit').mockImplementation((count) => limit(Math.min(count, 2)));
      return builder;
    }) as typeof db.from);
    // The already-read row remains counted, and deleting it cannot shift the
    // remaining pages past bill-2 as offset pagination would.
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toMatchObject({ ok: true, data: { total: 5, unknown: 5 } });
    expect(db.table('bills').map((row) => row.id)).toEqual(['bill-1', 'bill-2', 'bill-3', 'bill-4']);
  });

  it('fails closed when a server repeats a page instead of advancing the ID cursor', async () => {
    db.seed('bills', [{ id: 'bill-1', family_id: FAMILY }, { id: 'bill-2', family_id: FAMILY }]);
    const original = db.from.bind(db);
    let billReads = 0;
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      const builder = original(name);
      if (name !== 'bills') return builder;
      billReads++;
      const limit = builder.limit.bind(builder);
      vi.spyOn(builder, 'limit').mockImplementation((count) => limit(Math.min(count, 1)));
      vi.spyOn(builder, 'gt').mockImplementation(() => builder);
      return builder;
    }) as typeof db.from);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toEqual({ ok: false });
    expect(billReads).toBe(2);
  });

  it.each(['calendar_events', 'todo_items', 'bills', 'family_reminders', 'calendar_feeds', 'ai_tool_calls'])('returns unavailable on a %s read failure', async (table) => {
    db.seed('calendar_events', [{ id: 'event-1', family_id: FAMILY }]);
    readFailure(table);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toEqual({ ok: false });
  });

  it('does not show a partial count when a later page fails', async () => {
    db.seed('bills', Array.from({ length: 401 }, (_, i) => ({ id: `bill-${i}`, family_id: FAMILY })));
    readFailure('bills', 2);
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toEqual({ ok: false });
  });

  it('distinguishes a successful empty read from unavailable or a fabricated zero percent', async () => {
    expect(await loadAutomaticCaptureShare(db, FAMILY, NOW)).toMatchObject({ ok: true, data: { total: 0, automatic: 0, unknown: 0, minimumPercent: null } });
    expect(db.log.some((read) => read.table === 'ai_tool_calls')).toBe(false);
  });
});
