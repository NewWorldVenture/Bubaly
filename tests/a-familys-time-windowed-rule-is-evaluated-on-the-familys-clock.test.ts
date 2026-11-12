// LIBRARY-2DB3B841FC13: evaluateTrust passed `req.context` to the engine
// unchanged, loadTrustInputs read no family timezone, and none of the callers
// (wallet, money, concierge, the assistant's tools) set `localTime`. A family's
// time-windowed deny or require-approval policy therefore never applied.
//
// The bridge now reads the family's zone and the engine derives the local
// HH:MM from the evaluation instant. A zone that cannot be read while a
// time-windowed rule exists is a rule that cannot be evaluated, so the answer
// degrades to asking, the same as rules that did not load.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const holder = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));

const { evaluateTrust, loadTrustInputs } = await import('@/lib/trust/server');

type Row = Record<string, unknown>;

function store(seed: Record<string, Row[]>, failing: Set<string> = new Set()) {
  const inserted: { table: string; row: Row }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const failure = { data: null, error: { message: `${table} is unavailable` }, count: null };
    const list = () => (failing.has(table) ? failure : { data: seed[table] ?? [], error: null, count: (seed[table] ?? []).length });
    const one = () => (failing.has(table) ? failure : { data: (seed[table] ?? [])[0] ?? null, error: null });
    Object.assign(b, {
      select: () => b, eq: () => b, is: () => b, gt: () => b, lt: () => b, in: () => b,
      order: () => b, limit: () => b, or: () => b, filter: () => b,
      insert: (row: Row) => { inserted.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
      single: () => Promise.resolve(one()),
      maybeSingle: () => Promise.resolve(one()),
      then: (ok: (v: unknown) => void) => Promise.resolve(list()).then(ok),
    });
    return b;
  };
  const db = { from } as unknown as SupabaseClient<Database>;
  holder.service = db;
  return { db, inserted };
}

const FAMILY = 'fam-1';
const PARENT = { kind: 'member' as const, id: 'parent-1', role: 'parent' as const };
const NIGHT_DENY: Row = {
  id: 'pol-night', family_id: FAMILY, name: 'No shopping at night', domain: 'shopping', capability: 'all',
  subject_kind: 'everyone', subject_role: null, subject_member_id: null, effect: 'deny',
  conditions: { timeStart: '22:00', timeEnd: '06:00' }, approval_model: 'single', required_approvals: 1,
  priority: 300, enabled: true,
};
const ask = (db: SupabaseClient<Database>) => evaluateTrust(db, FAMILY, {
  actor: PARENT, domain: 'shopping', capability: 'edit', openApproval: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  // 23:30 in Los Angeles, 16:30 in Tokyo, 07:30 UTC.
  vi.setSystemTime(new Date('2026-11-11T07:30:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a family\'s time-windowed rule is evaluated on the family\'s clock', () => {
  it('loads the family\'s zone beside its rules', async () => {
    const { db } = store({ families: [{ id: FAMILY, timezone: 'America/Los_Angeles' }], trust_policies: [NIGHT_DENY] });
    expect(await loadTrustInputs(db, FAMILY)).toMatchObject({ timeZone: 'America/Los_Angeles', degraded: false });
  });

  it('a night-time deny applies at 23:30 in Los Angeles, with no caller naming the hour', async () => {
    const { db, inserted } = store({ families: [{ id: FAMILY, timezone: 'America/Los_Angeles' }], trust_policies: [NIGHT_DENY] });
    const { decision } = await ask(db);
    expect(decision).toMatchObject({ effect: 'deny', basis: 'policy', policyId: 'pol-night' });
    expect(inserted.filter((w) => w.table === 'trust_audit_logs').map((w) => w.row))
      .toEqual([expect.objectContaining({ decision: 'deny', policy_id: 'pol-night' })]);
  });

  it('the same instant is the afternoon for a family in Tokyo, and the rule does not apply', async () => {
    const { db } = store({ families: [{ id: FAMILY, timezone: 'Asia/Tokyo' }], trust_policies: [NIGHT_DENY] });
    expect((await ask(db)).decision).toMatchObject({ effect: 'allow', basis: 'role_default' });
  });

  it('a zone that cannot be read while a time-windowed rule exists asks instead of assuming', async () => {
    const { db } = store({ trust_policies: [NIGHT_DENY] }, new Set(['families']));
    expect(await loadTrustInputs(db, FAMILY)).toMatchObject({ timeZone: null, degraded: true });
    expect((await ask(db)).decision).toMatchObject({ effect: 'require_approval', basis: 'degraded' });
  });

  it('a family with no time-windowed rule is not held up by an unreadable zone', async () => {
    const { db } = store({ trust_policies: [{ ...NIGHT_DENY, conditions: {}, domain: 'banking' }] }, new Set(['families']));
    expect(await loadTrustInputs(db, FAMILY)).toMatchObject({ timeZone: null, degraded: false });
    expect((await ask(db)).decision).toMatchObject({ effect: 'allow', basis: 'role_default' });
  });
});
