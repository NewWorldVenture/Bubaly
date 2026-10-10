import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The approval sweeps RETURN a failure (a read or write they could not make)
// rather than throw. The cron counted a sweep failure only when it threw, so a
// tick in which approvals stopped expiring and reminders stopped going out
// answered 200 ok:true and monitoring never saw it.
const sweeps = vi.hoisted(() => ({
  expire: { expired: 0, blockedRuns: 0, failures: 0 },
  resume: { resumed: 0, failures: 0 },
  remind: { reminded: 0, families: 0, failures: 0 },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, { select: () => b, order: () => b, range: () => Promise.resolve({ data: [], error: null }) });
      return b;
    },
  }),
}));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/notifications', () => ({ generateFamilyNotifications: vi.fn().mockResolvedValue(0) }));
vi.mock('@/lib/server/push', () => ({ dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }) }));
vi.mock('@/lib/server/notification-emails', () => ({ deliverNotificationEmails: async () => ({ sent: 0, failed: 0, skipped: 0 }) }));
vi.mock('@/lib/briefing/deliver', () => ({ deliverMorningBriefs: async () => ({ delivered: 0, families: 0, skipped: 0, failed: 0 }) }));
vi.mock('@/lib/services/approvals', () => ({
  expireStale: async () => sweeps.expire,
  resumeSettledRuns: async () => sweeps.resume,
  remindPendingApprovals: async () => sweeps.remind,
}));

const { GET } = await import('@/app/api/cron/notifications/route');
const tick = () => GET(new NextRequest('https://bubaly.example.test/api/cron/notifications'));

beforeEach(() => {
  sweeps.expire = { expired: 0, blockedRuns: 0, failures: 0 };
  sweeps.resume = { resumed: 0, failures: 0 };
  sweeps.remind = { reminded: 0, families: 0, failures: 0 };
});

describe('the notifications cron reports an approval sweep that did not run', () => {
  it('answers 200 when every sweep ran', async () => {
    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, failed: 0 });
  });

  it.each([
    ['expiry', () => { sweeps.expire = { expired: 0, blockedRuns: 0, failures: 1 }; }],
    ['settled-run', () => { sweeps.resume = { resumed: 0, failures: 1 }; }],
    ['reminder', () => { sweeps.remind = { reminded: 0, families: 0, failures: 2 }; }],
  ])('answers 502 when the %s sweep returned a failure', async (_name, arrange) => {
    arrange();
    const res = await tick();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
