import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/cron/guardian-sms-recovery/route';

const seam = vi.hoisted(() => ({ client: {}, factory: vi.fn(), drain: vi.fn(), retry: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.factory }));
vi.mock('@/lib/guardian/sms-recovery', () => ({ drainGuardianSmsReceipts: seam.drain }));
vi.mock('@/lib/guardian/escalation-retry', () => ({ retryUndeliveredGuardianEscalations: seam.retry }));

const NOTHING_TO_RETRY = { examined: 0, delivered: 0, duplicate: 0, undelivered: 0, unreachable: 0, unavailable: 0 };

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'synthetic-recovery-cron-secret');
  seam.factory.mockReset().mockReturnValue(seam.client);
  seam.drain.mockReset().mockResolvedValue({ examined: 1, completed: 1, busy: 0, unavailable: 0 });
  seam.retry.mockReset().mockResolvedValue(NOTHING_TO_RETRY);
});
afterEach(() => vi.unstubAllEnvs());
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
    const req = request(), result = await GET(req);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, examined: 1, completed: 1, busy: 0, unavailable: 0, escalations: NOTHING_TO_RETRY });
    expect(seam.drain).toHaveBeenCalledWith(seam.client, { signal: req.signal });
    // The same tick re-attempts recent escalations that reached nobody: the
    // one Guardian job the dispatcher already fires every five minutes carries
    // the retry for all three inbound lanes.
    expect(seam.retry).toHaveBeenCalledWith(seam.client, { signal: req.signal });
  });
  it('reports an escalation that still reached nobody so the scheduler does not claim success', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 1, undelivered: 1 });
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ ok: false, escalations: { examined: 1, undelivered: 1 } });
  });
  it('a retry sweep that completed every escalation it found is a success', async () => {
    seam.retry.mockResolvedValue({ ...NOTHING_TO_RETRY, examined: 2, delivered: 1, duplicate: 1 });
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
  it.each(['factory', 'drain', 'retry'] as const)('does not expose %s errors or message contents', async stage => {
    if (stage === 'factory') seam.factory.mockImplementation(() => { throw new Error('Synthetic sensitive diagnostic'); });
    else if (stage === 'drain') seam.drain.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    else seam.retry.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, unavailable: 1 });
  });
});
