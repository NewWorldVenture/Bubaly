// The Guardian recovery tick shares one deadline between its two sweeps, ends
// inside the function's own lifetime, and stops when it is cancelled.
//
// The cron route (maxDuration 110 s) awaited the receipt drain — up to 80 s —
// and then the undelivered-escalation sweep, up to ten attempts of 30 s each,
// one after another, stopped only by req.signal, which the platform does not
// fire at maxDuration. In a slow Twilio outage it ran on for minutes: the
// function was killed mid-send, the dispatcher got a 504 and no counts, and a
// claim was left `processing` with its record unwritten. The probe that found
// it measured attempts still starting at 350 s and the route settling at 380 s.
//
// Driven here through the real route, the real drain and the real sweep, over
// a PostgREST fixture, with every receipt resume and every escalation attempt
// hanging until it is cut off — the slow outage — on a fake clock.
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';

const seam = vi.hoisted(() => ({
  client: null as unknown, resume: vi.fn(), escalate: vi.fn(),
  resumeStarts: [] as number[], attempts: [] as Array<{ start: number; end: number | null }>,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.client }));
vi.mock('@/lib/guardian/sms-processing', () => ({ resumeGuardianSms: seam.resume }));
vi.mock('@/lib/guardian/escalate', async (original) => ({
  ...await original<typeof import('@/lib/guardian/escalate')>(),
  escalateGuardianEmergency: seam.escalate,
}));

const DRAIN_KEY = 'guardian.sms_intake:recovery_cursor:v1';
const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const FAM = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
type Row = Record<string, unknown>;
type Candidate = { id: string; created_at?: string; escalated_at?: string };

/** PostgREST's tuple comparisons, as the drain and the sweep write them. */
function matchesFilter(expression: string, candidate: Candidate): boolean {
  const parts = (value: string) => {
    const result: string[] = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      else if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i)); start = i + 1; }
    }
    result.push(value.slice(start)); return result;
  };
  if (expression.startsWith('(')) return parts(expression.slice(1, -1)).some(part => matchesFilter(part, candidate));
  if (expression.startsWith('and(')) return parts(expression.slice(4, -1)).every(part => matchesFilter(part, candidate));
  if (expression.startsWith('or(')) return parts(expression.slice(3, -1)).some(part => matchesFilter(part, candidate));
  const match = /^(created_at|escalated_at|id)\.(eq|gt|lt|lte)\.(.+)$/.exec(expression);
  if (!match) throw new Error(`Unexpected tuple comparison ${expression}`);
  const actual = match[1] === 'id' ? candidate.id : Date.parse(String(candidate[match[1] as 'created_at' | 'escalated_at']));
  const expected = match[1] === 'id' ? match[3] : Date.parse(match[3]);
  return match[2] === 'eq' ? actual === expected : match[2] === 'gt' ? actual > expected : match[2] === 'lt' ? actual < expected : actual <= expected;
}

/** Eight receipts waiting for the drain, ten escalations that reached nobody, and the two cursors. */
function makeClient() {
  const settings = new Map<string, Row>();
  const receipts: Candidate[] = Array.from({ length: 8 }, (_, i) => ({ id: ID(i + 1), created_at: new Date(T0 - HOUR + i * 1000).toISOString() }));
  const escalations = Array.from({ length: 10 }, (_, i) => ({
    id: ID(100 + i), family_id: FAM(i), communication_id: null, escalation_type: 'medical', severity: 'critical',
    description: `synthetic emergency ${i}`, caller_number: '+15555550199', notified_member_ids: [],
    escalated_at: new Date(T0 - HOUR + i * 1000).toISOString(),
  }));
  return createClient<Database>('https://recovery-deadline.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!, method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : null;
      if (table === 'app_settings') {
        if (method === 'GET') {
          const key = url.searchParams.get('key')!.slice(3);
          const found = settings.has(key) ? [{ key, value: structuredClone(settings.get(key)) }] : [];
          return Response.json(found, { headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` } });
        }
        if (method === 'POST') {
          const upsert = (init.headers as Record<string, string> | undefined)?.Prefer?.includes('merge-duplicates')
            ?? new Headers(init.headers).get('prefer')?.includes('merge-duplicates');
          if (settings.has(String(body?.key)) && !upsert) return Response.json({ code: '23505' }, { status: 409 });
          settings.set(String(body?.key), structuredClone(body?.value as Row));
          return Response.json([{ key: body?.key }]);
        }
        if (method === 'PATCH') {
          const filter = JSON.parse(url.searchParams.get('value')!.slice(3)) as Row;
          const cursor = settings.get(DRAIN_KEY);
          if (cursor && cursor.revision === filter.revision && cursor.version === filter.version) settings.set(DRAIN_KEY, structuredClone(body?.value as Row));
          return Response.json([{ key: DRAIN_KEY }]);
        }
      }
      if (table === 'ai_tool_calls' && url.searchParams.get('tool_name') === 'eq.guardian.sms_intake') {
        let list = [...receipts];
        const filter = url.searchParams.get('or');
        if (filter) list = list.filter(c => matchesFilter(filter, c));
        list.sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!) || a.id.localeCompare(b.id));
        if (url.searchParams.get('order')?.startsWith('created_at.desc')) list.reverse();
        return Response.json(list.slice(0, 1));
      }
      // No escalation was left owed, and none of these has a claim yet.
      if (table === 'ai_tool_calls' && url.searchParams.get('tool_name') === 'eq.guardian.escalation_owed') return Response.json([]);
      if (table === 'guardian_callback_events' && method === 'GET') return Response.json([]);
      if (table === 'guardian_escalations' && method === 'GET') {
        const filter = url.searchParams.get('or');
        const list = escalations.filter((row) => !filter || matchesFilter(filter, row))
          .sort((a, b) => Date.parse(a.escalated_at) - Date.parse(b.escalated_at) || a.id.localeCompare(b.id));
        return Response.json(list.slice(0, Number(url.searchParams.get('limit') ?? 10)));
      }
      throw new Error(`Unexpected ${method} ${table}`);
    } },
  });
}
const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  // Node's AbortSignal.timeout runs on an internal timer the fake clock does
  // not drive; model it on setTimeout, which it does.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.stubEnv('CRON_SECRET', 'synthetic-recovery-cron-secret');
  seam.client = makeClient();
  seam.resumeStarts.length = 0; seam.attempts.length = 0;
  // A receipt whose resume hangs (a slow model or Twilio in an outage).
  seam.resume.mockReset().mockImplementation(() => { seam.resumeStarts.push(Date.now() - T0); return new Promise(() => {}); });
  // An escalation whose Twilio requests hang until its deadline cuts them
  // off; it then writes its record (a moment) and answers `interrupted`.
  seam.escalate.mockReset().mockImplementation((_client: unknown, _input: unknown, { signal }: { signal: AbortSignal }) => {
    const attempt = { start: Date.now() - T0, end: null as number | null };
    seam.attempts.push(attempt);
    return new Promise((resolve) => signal.addEventListener('abort', () => {
      setTimeout(() => { attempt.end = Date.now() - T0; resolve({ kind: 'interrupted', pushSent: true, notifiedCount: 0, recorded: true, owed: false }); }, 200);
    }, { once: true }));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function request(signal?: AbortSignal) {
  return new NextRequest('https://recovery-deadline.invalid/api/cron/guardian-sms-recovery', { headers: { authorization: 'Bearer synthetic-recovery-cron-secret' }, ...(signal ? { signal } : {}) });
}

describe('the Guardian recovery tick', () => {
  it('ends both sweeps inside maxDuration, with time kept back for the escalation retries, and says what it left', async () => {
    const { GET, maxDuration } = await import('@/app/api/cron/guardian-sms-recovery/route');
    let settledAt: number | null = null;
    const pending = GET(request()).then((res) => { settledAt = Date.now() - T0; return res; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const res = await pending;
    const body = await res.json() as { ok: boolean; escalations: Record<string, number> };

    // The drain began at once and was held to its part of the tick.
    expect(seam.resumeStarts[0]).toBeLessThan(1000);
    // The defect: ten attempts, the first at 80 s and the last at 350 s, and
    // the route settling at 380 s — long after the platform kills it.
    expect(settledAt).not.toBeNull();
    expect(settledAt!).toBeLessThan(maxDuration * 1000);
    // Every attempt that started also ended — cut off, its record written —
    // before the function's end, and none started without time to finish.
    expect(seam.attempts.length).toBeGreaterThanOrEqual(1);
    for (const attempt of seam.attempts) {
      expect(attempt.end).not.toBeNull();
      expect(attempt.end!).toBeLessThan(maxDuration * 1000);
    }
    // However long the drain took, the escalations still got their turn.
    expect(seam.attempts[0].start).toBeLessThan(60_000);
    // What it could not reach is reported, not lost: not a 504, a 503 with counts.
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.escalations.examined).toBe(seam.attempts.length);
    expect(body.escalations.examined + body.escalations.deferred).toBe(10);
    expect(body.escalations.deferred).toBeGreaterThan(0);
  });

  it('stops when it is cancelled: the drain ends, and the sweep starts no attempt', async () => {
    const { GET } = await import('@/app/api/cron/guardian-sms-recovery/route');
    const controller = new AbortController();
    let settledAt: number | null = null;
    const pending = GET(request(controller.signal)).then((res) => { settledAt = Date.now() - T0; return res; });
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const res = await pending;
    expect(settledAt!).toBeLessThan(15_000);
    expect(seam.attempts).toEqual([]);
    expect(res.status).toBe(503);
    expect((await res.json() as { escalations: Record<string, number> }).escalations).toMatchObject({ examined: 0 });
  });

  it('the next tick starts where this one stopped', async () => {
    const { GET } = await import('@/app/api/cron/guardian-sms-recovery/route');
    const first = GET(request());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await first;
    const reached = seam.escalate.mock.calls.map(([, input]) => (input as { familyId: string }).familyId);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.length).toBeLessThan(10);
    seam.escalate.mockClear();
    const second = GET(request());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await second;
    const next = seam.escalate.mock.calls.map(([, input]) => (input as { familyId: string }).familyId);
    // Not the same oldest records again: the ones the first tick left.
    expect(next[0]).toBe(FAM(reached.length));
    expect(next.some((family) => reached.includes(family))).toBe(false);
  });
});
