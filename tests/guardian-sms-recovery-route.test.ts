import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, maxDuration } from '@/app/api/cron/guardian-sms-recovery/route';

const seam = vi.hoisted(() => ({ client: {}, factory: vi.fn(), drain: vi.fn(), retry: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.factory }));
vi.mock('@/lib/guardian/sms-recovery', () => ({ drainGuardianSmsReceipts: seam.drain }));
vi.mock('@/lib/guardian/escalation-retry', async (original) => ({
  ...await original<typeof import('@/lib/guardian/escalation-retry')>(),
  retryUndeliveredGuardianEscalations: seam.retry,
}));

const NOTHING_TO_RETRY = { examined: 0, delivered: 0, duplicate: 0, undelivered: 0, unreachable: 0, unavailable: 0, deferred: 0, recovered: 0 };
const T0 = Date.parse('2026-10-11T02:10:00.000Z');

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'synthetic-recovery-cron-secret');
  seam.factory.mockReset().mockReturnValue(seam.client);
  seam.drain.mockReset().mockResolvedValue({ examined: 1, completed: 1, busy: 0, unavailable: 0 });
  seam.retry.mockReset().mockResolvedValue(NOTHING_TO_RETRY);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function request(authorization = 'Bearer synthetic-recovery-cron-secret') {
  return new NextRequest('https://recovery-fixture.invalid/api/cron/guardian-sms-recovery', { headers: { authorization } });
}

describe('Guardian SMS recovery scheduled HTTP boundary', () => {
  it.each(['', 'Bearer wrong', 'Bearer undefined'])('rejects invalid authorization before privileged work (%j)', async authorization => {
    expect((await GET(request(authorization))).status).toBe(401);
    expect(seam.factory).not.toHaveBeenCalled();
    expect(seam.drain).not.toHaveBeenCalled();
  });
  it('rejects absent deployment configuration', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(request())).status).toBe(401);
    expect(seam.factory).not.toHaveBeenCalled();
  });
  it('runs the bounded drainer and returns only aggregate counts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    const req = request(), result = await GET(req);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, examined: 1, completed: 1, busy: 0, unavailable: 0, escalations: NOTHING_TO_RETRY });
    // One deadline for the whole tick, inside maxDuration: the drain gets its
    // part of it and the escalation sweep the rest, and both get the request's
    // own signal.
    expect(seam.drain).toHaveBeenCalledWith(seam.client, { signal: req.signal, deadline: T0 + 55_000 });
    // The same tick re-attempts recent escalations that reached nobody: the
    // Guardian recovery job carries the retry for all three inbound lanes.
    expect(seam.retry).toHaveBeenCalledWith(seam.client, { signal: req.signal, deadline: T0 + 100_000 });
    expect(100_000).toBeLessThan(maxDuration * 1000);
  });
  it('reports an escalation that still reached nobody so the scheduler does not claim success', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 1, undelivered: 1 });
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ ok: false, escalations: { examined: 1, undelivered: 1 } });
  });
  it('reports escalations the tick ran out of time for, so the scheduler does not claim success', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 2, delivered: 2, deferred: 3 });
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ ok: false, escalations: { examined: 2, delivered: 2, deferred: 3 } });
  });
  it('a retry sweep that completed every escalation it found is a success', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 2, delivered: 1, duplicate: 1, recovered: 1 });
    expect((await GET(request())).status).toBe(200);
  });
  it('an escalation with nobody to text or call owes nothing: not a failure the scheduler should keep seeing', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 1, unreachable: 1 });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, escalations: { examined: 1, unreachable: 1 } });
  });
  it('reports temporarily owned work without duplicating its processing', async () => {
    seam.drain.mockResolvedValue({ examined: 1, completed: 0, busy: 1, unavailable: 0 });
    expect((await GET(request())).status).toBe(200);
  });
  it('reports processing failures so the scheduler does not claim success', async () => {
    seam.drain.mockResolvedValue({ examined: 1, completed: 0, busy: 0, unavailable: 1 });
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect((await result.json()).ok).toBe(false);
  });
  it('a drain that throws does not cost the emergency retries their tick, and the answer says what the sweep did', async () => {
    // The defect: drain and sweep shared one try, so any exception in the
    // drain (a cursor it could not read, a query that timed out) skipped the
    // only retrier of an emergency that reached nobody, and the 503 said
    // nothing about escalations at all.
    seam.drain.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 1, delivered: 1 });
    const result = await GET(request());
    expect(seam.retry).toHaveBeenCalledOnce();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, examined: 0, completed: 0, busy: 0, unavailable: 1, escalations: { ...NOTHING_TO_RETRY, examined: 1, delivered: 1 } });
  });
  it.each([
    ['factory', { ok: false, unavailable: 1, escalations: { ...NOTHING_TO_RETRY, unavailable: 1 } }],
    ['drain', { ok: false, examined: 0, completed: 0, busy: 0, unavailable: 1, escalations: NOTHING_TO_RETRY }],
    ['retry', { ok: false, examined: 1, completed: 1, busy: 0, unavailable: 0, escalations: { ...NOTHING_TO_RETRY, unavailable: 1 } }],
  ] as const)('does not expose %s errors or message contents', async (stage, body) => {
    if (stage === 'factory') seam.factory.mockImplementation(() => { throw new Error('Synthetic sensitive diagnostic'); });
    else if (stage === 'drain') seam.drain.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    else seam.retry.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    const result = await GET(request());
    expect(result.status).toBe(503);
    const text = await result.text();
    expect(text).not.toContain('Synthetic sensitive diagnostic');
    expect(JSON.parse(text)).toEqual(body);
  });
});
