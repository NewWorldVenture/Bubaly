// The nightly Guardian learning cron, driven through its real route, the real
// learning lease and the real learning run (lib/guardian/learning-run.ts)
// against the in-memory database. The cron authorization is the real one, over
// a stubbed secret; only the session-less translator is replaced.
//
// Two open households each have a number Bubaly caught scamming three times —
// one "Block this number?" suggestion each. Beside them: a closed household
// with the same pattern (no new suggestion; its expired pending suggestion is
// still housekeeping and is auto-dismissed), a household whose activity is
// older than the 60-day window, and in household A a number the parents already
// dismissed a block for inside the window (already answered, not filed again).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, clients: 0 }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { h.clients++; return h.db; } }));

const { GET } = await import('@/app/api/cron/guardian-learning/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-11-12T12:00:00.000Z');
const DAY = 86_400_000;
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const CLOSED = '00000000-0000-4000-8000-0000000000c1';
const STALE = '00000000-0000-4000-8000-0000000000e1';
const PHONE = { a: '+15550100001', aAnswered: '+15550100003', b: '+15550100002', closed: '+15550100004', stale: '+15550100005' };

let db: InMemorySupabase;
const req = (authorization?: string) => new Request('https://bubaly.test/api/cron/guardian-learning', {
  headers: authorization ? { authorization } : {},
}) as never;
const authorized = () => req(`Bearer ${SECRET}`);
const suggestionsOf = (familyId: string) => db.table('guardian_suggestions').filter((r) => r.family_id === familyId);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let commSeq = 0;
function scamCalls(familyId: string, phone: string, daysAgo: number[]) {
  db.seed('guardian_communications', daysAgo.map((d) => ({
    id: `00000000-0000-4000-9000-${String(++commSeq).padStart(12, '0')}`, family_id: familyId, member_id: null,
    comm_type: 'call_inbound', direction: 'inbound', from_number: phone, contact_id: null, scam_detected: true,
    trust_level_at_time: 'unknown', status: 'blocked', started_at: ago(d),
  })));
}

function seed() {
  commSeq = 0;
  db.seed('families', [
    { id: A, name: 'Household A', timezone: 'Europe/Berlin', closed_at: null },
    { id: B, name: 'Household B', timezone: 'America/New_York', closed_at: null },
    { id: CLOSED, name: 'Closed household', timezone: 'UTC', closed_at: '2026-10-01T00:00:00.000Z' },
    { id: STALE, name: 'Quiet household', timezone: 'UTC', closed_at: null },
  ]);
  scamCalls(A, PHONE.a, [1, 2, 3]);
  scamCalls(A, PHONE.aAnswered, [4, 5]);
  scamCalls(B, PHONE.b, [1, 2, 3]);
  scamCalls(CLOSED, PHONE.closed, [1, 2, 3]);
  scamCalls(STALE, PHONE.stale, [70, 71, 72]);
  db.seed('guardian_suggestions', [
    // A's parents already said no to blocking this number, inside the lookback.
    { id: '00000000-0000-4000-8000-00000000a5a1', family_id: A, suggestion_type: 'flag_scam', status: 'dismissed', title: 'Block?', reasoning: 'Flagged twice.', evidence: { phone: PHONE.aAnswered },
      proposed_contact_id: null, proposed_trust_level: 'blocked', created_at: ago(10), expires_at: ago(-20) },
    // Expired and still pending, in the closed family: housekeeping runs for everyone.
    { id: '00000000-0000-4000-8000-00000000c5c1', family_id: CLOSED, suggestion_type: 'new_rule', status: 'pending', title: 'Quiet hours?', reasoning: 'Late calls.', evidence: {},
      proposed_contact_id: null, proposed_trust_level: null, created_at: ago(40), expires_at: ago(1) },
    // Pending and not yet expired, in B: left as it is.
    { id: '00000000-0000-4000-8000-00000000b5b1', family_id: B, suggestion_type: 'new_rule', status: 'pending', title: 'Quiet hours?', reasoning: 'Late calls.', evidence: {},
      proposed_contact_id: null, proposed_trust_level: null, created_at: ago(2), expires_at: ago(-5) },
  ]);
}

/** Every table touched, through `from` or `rpc`, on the client the route is handed. */
function recording(target: InMemorySupabase) {
  const touched: string[] = [];
  const client = new Proxy(target as object, {
    get(obj, prop, receiver) {
      if (prop === 'from' || prop === 'rpc') {
        return (name: string, ...rest: unknown[]) => {
          touched.push(`${String(prop)}:${name}`);
          return (Reflect.get(obj, prop, receiver) as (...a: unknown[]) => unknown).call(obj, name, ...rest);
        };
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { client, touched };
}

const newBlocks = (familyId: string) => suggestionsOf(familyId)
  .filter((s) => s.status === 'pending' && s.suggestion_type === 'flag_scam')
  .map((s) => (s.evidence as { phone: string }).phone);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The column defaults 01370 gives guardian_suggestions (status 'pending', expiry a month out).
  db = createInMemorySupabase({
    uniques: { app_settings: [['key']] },
    defaults: { guardian_suggestions: { status: 'pending', expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString() } },
  });
  seed();
  h.db = db;
  h.clients = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization', () => {
  it('API-24F0D3A37ABD JOB-7663A237FE3C: refuses a request with no Authorization header before any read or the expiry sweep', async () => {
    const { client, touched } = recording(db);
    h.db = client;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
    expect(h.clients).toBe(0);
    expect(db.table('guardian_suggestions').map((s) => s.status)).toEqual(['dismissed', 'pending', 'pending']);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: refuses a wrong secret before any read or the expiry sweep', async () => {
    const { client, touched } = recording(db);
    h.db = client;
    const res = await GET(req('Bearer wrong-cron-secret-not-real'));
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
    expect(h.clients).toBe(0);
    expect(db.table('guardian_suggestions')).toHaveLength(3);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: runs with the right secret', async () => {
    const res = await GET(authorized());
    expect(res.status).toBe(200);
  });
});

describe('a populated run', () => {
  it('API-24F0D3A37ABD JOB-7663A237FE3C: files one block suggestion for each active open family, none for the closed or the quiet one, and answers what it did', async () => {
    const res = await GET(authorized());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, families: 2, suggestionsCreated: 2, failed: 0, busy: 0, unreached: 0, timedOut: 0 });
    expect(newBlocks(A)).toEqual([PHONE.a]);
    expect(newBlocks(B)).toEqual([PHONE.b]);
    expect(newBlocks(CLOSED)).toEqual([]);
    expect(suggestionsOf(STALE)).toEqual([]);
    // Each run that created something is in the audit trail, as the AI's.
    expect(db.table('guardian_audit_log').map((r) => [r.family_id, r.actor, r.action]).sort())
      .toEqual([[A, 'ai', 'learning.suggestions_generated'], [B, 'ai', 'learning.suggestions_generated']]);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: a number the parents already answered inside the window is not suggested again', async () => {
    await GET(authorized());
    expect(suggestionsOf(A).filter((s) => (s.evidence as { phone?: string }).phone === PHONE.aAnswered).map((s) => s.status)).toEqual(['dismissed']);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: auto-dismisses an expired pending suggestion (a closed family\'s too) and leaves an unexpired one pending', async () => {
    await GET(authorized());
    const byId = (id: string) => db.table('guardian_suggestions').find((s) => s.id === id)?.status;
    expect(byId('00000000-0000-4000-8000-00000000c5c1')).toBe('auto_dismissed');
    expect(byId('00000000-0000-4000-8000-00000000b5b1')).toBe('pending');
    expect(byId('00000000-0000-4000-8000-00000000a5a1')).toBe('dismissed');
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: releases every family\'s learning lease, so the next run is not told the family is busy', async () => {
    await GET(authorized());
    const res = await GET(authorized());
    expect((await res.json()).busy).toBe(0);
  });
});

describe('family isolation', () => {
  it('API-24F0D3A37ABD JOB-7663A237FE3C: nothing derived from household A\'s calls reaches household B, or the other way round', async () => {
    await GET(authorized());
    const text = (family: string) => JSON.stringify([
      suggestionsOf(family), db.table('guardian_audit_log').filter((r) => r.family_id === family),
    ]);
    expect(text(A)).toContain(PHONE.a.slice(-4));
    expect(text(A)).not.toContain(PHONE.b.slice(-4));
    expect(text(B)).toContain(PHONE.b.slice(-4));
    expect(text(B)).not.toContain(PHONE.a.slice(-4));
    expect(text(B)).not.toContain(PHONE.closed.slice(-4));
    // Each family's count is its own three calls, not the platform's.
    expect(suggestionsOf(B).filter((s) => s.suggestion_type === 'flag_scam').map((s) => s.evidence)).toEqual([{ phone: PHONE.b, scam_count: 3, total: 3 }]);
  });
});

describe('idempotence and failure', () => {
  it('API-24F0D3A37ABD JOB-7663A237FE3C: a second run files nothing new', async () => {
    await GET(authorized());
    const suggestions = db.table('guardian_suggestions').length;
    const audits = db.table('guardian_audit_log').length;

    const res = await GET(authorized());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, families: 2, suggestionsCreated: 0, failed: 0 });
    expect(db.table('guardian_suggestions')).toHaveLength(suggestions);
    expect(db.table('guardian_audit_log')).toHaveLength(audits);
    expect(suggestions).toBe(5);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: one family\'s unreadable contacts is that family\'s failure, reported as 502, while the other family still learns', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'guardian_contacts' && calls.some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === A)
      ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

    const res = await GET(authorized());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, families: 2, failed: 1, suggestionsCreated: 1 });
    expect(newBlocks(A)).toEqual([]);
    expect(newBlocks(B)).toEqual([PHONE.b]);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: a failed expiry sweep fails the run with 500 before any family is learned for', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'guardian_suggestions' && calls.some((c) => c.method === 'update')
      ? { code: '08006', message: 'connection lost' } : null));

    const res = await GET(authorized());

    expect(res.status).toBe(500);
    expect(newBlocks(A)).toEqual([]);
    expect(newBlocks(B)).toEqual([]);
    expect(db.table('guardian_audit_log')).toEqual([]);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: an unreadable activity lookup fails the run with 500 and learns for nobody', async () => {
    h.db = withFaults(db, (table) => (table === 'guardian_communications' ? { code: '08006', message: 'connection lost' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(500);
    expect(newBlocks(A)).toEqual([]);
    expect(newBlocks(B)).toEqual([]);
  });

  it('API-24F0D3A37ABD JOB-7663A237FE3C: an unreadable open-family check fails the run with 500 rather than learning for a family that may be closed', async () => {
    h.db = withFaults(db, (table) => (table === 'families' ? { code: '08006', message: 'connection lost' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(500);
    expect(newBlocks(A)).toEqual([]);
    expect(newBlocks(CLOSED)).toEqual([]);
  });
});
