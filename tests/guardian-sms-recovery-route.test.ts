import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/cron/guardian-sms-recovery/route';

const seam = vi.hoisted(() => ({ client: {}, factory: vi.fn(), drain: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.factory }));
vi.mock('@/lib/guardian/sms-recovery', () => ({ drainGuardianSmsReceipts: seam.drain }));

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'synthetic-recovery-cron-secret');
  seam.factory.mockReset().mockReturnValue(seam.client);
  seam.drain.mockReset().mockResolvedValue({ examined: 1, completed: 1, busy: 0, unavailable: 0 });
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
    expect(await result.json()).toEqual({ ok: true, examined: 1, completed: 1, busy: 0, unavailable: 0 });
    expect(seam.drain).toHaveBeenCalledWith(seam.client, { signal: req.signal });
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
  it.each(['factory', 'drain'] as const)('does not expose %s errors or message contents', async stage => {
    if (stage === 'factory') seam.factory.mockImplementation(() => { throw new Error('Synthetic sensitive diagnostic'); });
    else seam.drain.mockRejectedValue(new Error('Synthetic sensitive diagnostic'));
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, unavailable: 1 });
  });
});
