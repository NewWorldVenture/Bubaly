// §49's delivery half. The brief had exactly one composer — a POST handler a
// page calls when somebody opens it — so `markDelivered` and `loadBrief` had
// zero callers, `home_briefs.delivered_at` was written by nothing, and a brief
// only existed if a person went looking for it.
//
// The two failures a family would notice are being told twice, and being told
// at the wrong hour because "morning" was computed in UTC.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAISettings: vi.fn(),
  notify: vi.fn(),
  loadBrief: vi.fn(),
  saveBrief: vi.fn(),
  markDelivered: vi.fn(),
  collectBriefSource: vi.fn(),
  buildBrief: vi.fn(),
}));

const state = vi.hoisted(() => ({ families: [] as Record<string, unknown>[] }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      const reply = { data: state.families, error: null };
      Object.assign(b, {
        select: () => b, eq: () => b, limit: () => b,
        then: (resolve: (v: unknown) => void) => resolve(reply),
      });
      return b;
    },
  }),
}));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: (req: Request) => req.headers.get('authorization') === 'Bearer test-secret' }));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: mocks.getAISettings }));
vi.mock('@/lib/services/notifications', () => ({ notify: mocks.notify }));
vi.mock('@/lib/briefing/store', () => ({ loadBrief: mocks.loadBrief, saveBrief: mocks.saveBrief, markDelivered: mocks.markDelivered }));
vi.mock('@/lib/briefing/collect', () => ({ collectBriefSource: mocks.collectBriefSource }));
vi.mock('@/lib/briefing/build', () => ({ buildBrief: mocks.buildBrief }));

const { GET } = await import('@/app/api/cron/daily-brief/route');

const req = (auth = 'Bearer test-secret') => new Request('https://bubaly.test/api/cron/daily-brief', { headers: { authorization: auth } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 12:00 UTC = 7am in New York (EDT), 5am in Los Angeles.
  vi.setSystemTime(new Date('2026-09-05T11:00:00.000Z'));
  state.families = [
    { id: 'ny', timezone: 'America/New_York' },
    { id: 'la', timezone: 'America/Los_Angeles' },
  ];
  mocks.getAISettings.mockResolvedValue({ familyId: 'ny', enabled: true, behavior: 'execute', categoryBehavior: {}, riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null });
  mocks.loadBrief.mockResolvedValue({ ok: true, data: null });
  mocks.collectBriefSource.mockResolvedValue({ events: [], snapshot: {}, completedRuns: [], activity: [] });
  mocks.buildBrief.mockReturnValue({ kind: 'daily', asOfDate: '2026-09-05', headline: '3 things today', isSparse: false });
  mocks.saveBrief.mockResolvedValue({ ok: true, data: { id: 'brief-1' } });
  mocks.notify.mockResolvedValue({ ok: true, data: { created: 2 } });
  mocks.markDelivered.mockResolvedValue({ ok: true, data: true });
});

describe('the daily brief worker', () => {
  it('refuses an unauthorized caller', async () => {
    const res = await GET(req('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('delivers at 7am in the family’s own zone, not the server’s', async () => {
    // 11:00 UTC is 7am in New York and 4am in Los Angeles. Exactly one family
    // is due — which is the whole reason this runs hourly.
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ considered: 1, delivered: 1 });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({ familyId: 'ny', actorKind: 'system' });
    expect(mocks.notify.mock.calls[0][1]).toMatchObject({ recipients: 'managers', body: '3 things today', relatedId: 'brief-1' });
  });

  it('composes the brief itself when nobody opened the page', async () => {
    await GET(req() as never);
    expect(mocks.collectBriefSource).toHaveBeenCalledTimes(1);
    // Deterministic: no provider, no model call, no tokens.
    expect(mocks.buildBrief).toHaveBeenCalledTimes(1);
    expect(mocks.saveBrief).toHaveBeenCalledTimes(1);
  });

  it('uses the brief the page already filed rather than composing a second one', async () => {
    mocks.loadBrief.mockResolvedValue({ ok: true, data: { id: 'brief-page', brief: { headline: 'from the page' }, deliveredAt: null } });
    await GET(req() as never);
    expect(mocks.collectBriefSource).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls[0][1]).toMatchObject({ body: 'from the page', relatedId: 'brief-page' });
  });

  it('tells a family once — a brief already delivered is left alone', async () => {
    mocks.loadBrief.mockResolvedValue({ ok: true, data: { id: 'brief-1', brief: { headline: 'x' }, deliveredAt: '2026-09-05T11:00:00.000Z' } });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ delivered: 0, skipped: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not count a delivery the compare-and-set lost', async () => {
    // Another worker stamped it between our read and our write. The
    // notification may already have gone out from there; ours must not claim it.
    mocks.markDelivered.mockResolvedValue({ ok: true, data: false });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ delivered: 0, skipped: 1 });
  });

  it('says nothing to a family that switched Bubaly off', async () => {
    mocks.getAISettings.mockResolvedValue({ familyId: 'ny', enabled: false, behavior: 'execute', categoryBehavior: {}, riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ delivered: 0, skipped: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not wake a family whose day is genuinely empty', async () => {
    mocks.buildBrief.mockReturnValue({ kind: 'daily', asOfDate: '2026-09-05', headline: 'Nothing on', isSparse: true });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ delivered: 0, skipped: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
    // The brief is still filed, so opening the page shows the same one.
    expect(mocks.saveBrief).toHaveBeenCalledTimes(1);
  });
});
