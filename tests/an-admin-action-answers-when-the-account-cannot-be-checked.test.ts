// SRV-001 l6 — an admin action ANSWERS when the account cannot be checked; it
// does not reject.
//
// getUser() and isSuperAdmin() raise on a retryable auth failure, correctly —
// "we could not tell" is not "signed out". But the admin actions awaited them
// before their own try, so the action REJECTED instead of returning the result
// its caller branches on. On /admin/stripe and /admin/services that left the
// button spinning with no message until a reload (the operator could not tell
// whether the keys were saved; they were not); the <form action> forms fell to
// the error boundary and threw away what had been typed.
//
// Each action here must now resolve to `ok: false` with the catalogue's
// "Account context is temporarily unavailable." and write nothing.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const UNAVAILABLE = EN_US['ai.accountContextIsTemporarilyUnavailable'];
const h = vi.hoisted(() => ({
  mode: 'throws' as 'throws' | 'throws-admin' | 'forbidden' | 'non-admin' | 'allowed',
  assurance: true,
  serviceClient: vi.fn(),
}));

// The admin gates also ask lib/auth/super-admin-assurance whether the session
// proved its authenticator; denied controls verify that gate remains intact.
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: h.assurance }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => {
    if (h.mode === 'throws') throw new Error('Account context is temporarily unavailable.');
    return h.mode === 'forbidden' ? null : { id: 'admin-1', email: 'admin@example.com' };
  },
  isSuperAdmin: async () => {
    if (h.mode === 'throws' || h.mode === 'throws-admin') throw new Error('Account context is temporarily unavailable.');
    return h.mode === 'allowed';
  },
  requireUserContext: async () => { throw new Error('not used here'); },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => h.serviceClient(...args),
  createServer: async () => { throw new Error('nothing may be written'); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));

const { superAdminGate } = await import('@/lib/auth/super-admin-gate');
const { saveAIConfigAction, testAIConnectionAction } = await import('@/app/(app)/admin/ai/actions');
const { saveSocialLinksAction } = await import('@/app/(app)/admin/settings/social-links/actions');
const { setFeatureTierAction, resetFeatureTiersAction } = await import('@/app/(app)/admin/tier-features/actions');
const { saveServiceDescriptionAction, resetServiceDescriptionAction } = await import('@/app/(app)/admin/services/actions');
const { saveStripeSettingsAction, testStripeConnectionAction } = await import('@/app/(app)/admin/actions');
const tickets = await import('@/app/(app)/admin/support-tickets/actions');
const reports = await import('@/app/(app)/admin/marketplace/reports/actions');

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const supportAndModerationActions: [string, () => Promise<unknown>][] = [
  ['resolveTicketAction', () => tickets.resolveTicketAction('ticket-1')],
  ['closeTicketAction', () => tickets.closeTicketAction('ticket-1')],
  ['reopenTicketAction', () => tickets.reopenTicketAction('ticket-1')],
  ['assignTicketToMeAction', () => tickets.assignTicketToMeAction('ticket-1')],
  ['createTicketAction', () => tickets.createTicketAction(form({ subject: 'Unable to save', requester_email: 'requester@example.com' }))],
  ['resolveReportAction', () => reports.resolveReportAction({ id: 'report-1', status: 'actioned', withdrawListing: true })],
  ['startReviewAction', () => reports.startReviewAction('report-1')],
];

beforeEach(() => {
  h.mode = 'throws';
  h.assurance = true;
  h.serviceClient.mockReset().mockImplementation(() => { throw new Error('nothing may be written'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('superAdminGate is an answer, never a throw', () => {
  it('is unavailable when the auth check throws', async () => {
    expect(await superAdminGate()).toEqual({ status: 'unavailable' });
  });
  it('is forbidden for nobody signed in, and for a signed-in non-admin', async () => {
    h.mode = 'forbidden';
    expect(await superAdminGate()).toEqual({ status: 'forbidden' });
  });
  it('is allowed, with the user, for a super admin', async () => {
    h.mode = 'allowed';
    expect(await superAdminGate()).toMatchObject({ status: 'allowed', user: { id: 'admin-1' } });
  });
});

describe('an admin action whose auth check throws resolves with a sentence and writes nothing', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['saveAIConfigAction', () => saveAIConfigAction(form({ model: 'gpt-x', openaiKey: 'sk-test' }))],
    ['saveSocialLinksAction', () => saveSocialLinksAction(form({ revision: 'r1' }))],
    ['setFeatureTierAction', () => setFeatureTierAction('meals', 'plus')],
    ['resetFeatureTiersAction', () => resetFeatureTiersAction()],
    ['saveServiceDescriptionAction', () => saveServiceDescriptionAction({ key: '/dashboard/meals', description: 'x' })],
    ['resetServiceDescriptionAction', () => resetServiceDescriptionAction({ key: '/dashboard/meals' })],
    ['saveStripeSettingsAction', () => saveStripeSettingsAction({
      enabled: true, publishableKey: null, secretKey: null, webhookSecret: null,
      connectAccountId: null, serviceFeeCents: 90, serviceFeePriceId: null,
    })],
    ['testStripeConnectionAction', () => testStripeConnectionAction()],
    ...supportAndModerationActions,
  ];

  it.each(cases)('%s', async (_name, run) => {
    expect(UNAVAILABLE).toEqual(expect.any(String));
    await expect(run()).resolves.toEqual({ ok: false, error: UNAVAILABLE });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });

  it('testAIConnectionAction answers with its own result shape', async () => {
    await expect(testAIConnectionAction()).resolves.toEqual({ ok: false, code: 'unavailable', message: UNAVAILABLE, detail: '' });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });
});

describe('a caller who is not a super admin is still refused, as before', () => {
  it('forbidden is not unavailable', async () => {
    h.mode = 'forbidden';
    await expect(saveAIConfigAction(form({ model: 'gpt-x' }))).resolves.toEqual({ ok: false, error: EN_US['actions.forbidden'] });
    await expect(setFeatureTierAction('meals', 'plus')).resolves.toEqual({ ok: false, error: EN_US['actions.notAuthorized'] });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });
});

describe('ticket and moderation controls distinguish refusal from an unavailable account', () => {
  it.each(supportAndModerationActions)('%s answers when the super-admin check fails after reading the user', async (_name, run) => {
    h.mode = 'throws-admin';
    await expect(run()).resolves.toEqual({ ok: false, error: UNAVAILABLE });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });

  it.each(supportAndModerationActions)('%s refuses signed-out and signed-in non-admin callers before creating a privileged client', async (_name, run) => {
    for (const mode of ['forbidden', 'non-admin'] as const) {
      h.mode = mode;
      await expect(run()).resolves.toEqual({ ok: false, error: EN_US['actions.notAuthorized'] });
    }
    expect(h.serviceClient).not.toHaveBeenCalled();
  });

  it.each(supportAndModerationActions)('%s still requires the admin authenticator', async (_name, run) => {
    h.mode = 'allowed';
    h.assurance = false;
    await expect(run()).resolves.toEqual({ ok: false, error: EN_US['actions.adminConsoleNeedsYourCode'] });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });
});

describe('a permitted admin can still manage tickets and review reports', () => {
  it.each(supportAndModerationActions)('%s reaches its intended write', async (name, run) => {
    h.mode = 'allowed';
    const writes: { table: string; kind: string; payload: Record<string, unknown>; filters: [string, unknown][] }[] = [];
    h.serviceClient.mockImplementation(() => ({
      from(table: string) {
        const filters: [string, unknown][] = [];
        const builder = {
          select: () => builder,
          eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          in: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          update: (payload: Record<string, unknown>) => { writes.push({ table, kind: 'update', payload, filters }); return builder; },
          insert: (payload: Record<string, unknown>) => { writes.push({ table, kind: 'insert', payload, filters }); return Promise.resolve({ data: null, error: null }); },
          maybeSingle: async () => ({ data: { id: table === 'support_tickets' ? 'ticket-1' : 'report-1', listing_id: null, status: 'open' }, error: null }),
        };
        return builder;
      },
    }));

    await expect(run()).resolves.toEqual({ ok: true });
    expect(h.serviceClient).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (name === 'createTicketAction') {
      expect(write).toMatchObject({ table: 'support_tickets', kind: 'insert', payload: { subject: 'Unable to save', requester_email: 'requester@example.com' } });
    } else if (name === 'assignTicketToMeAction') {
      expect(write).toMatchObject({ table: 'support_tickets', kind: 'update', payload: { assigned_agent_id: 'admin-1', assigned_agent_name: 'admin@example.com' } });
      expect(write.filters).toContainEqual(['id', 'ticket-1']);
    } else if (name === 'resolveReportAction' || name === 'startReviewAction') {
      expect(write).toMatchObject({ table: 'marketplace_reports', kind: 'update', payload: { status: name === 'resolveReportAction' ? 'actioned' : 'reviewing', reviewed_by: 'admin-1' } });
      expect(write.filters).toContainEqual(['id', 'report-1']);
      expect(write.filters).toContainEqual(['status', name === 'resolveReportAction' ? ['open', 'reviewing'] : 'open']);
    } else {
      const status = name === 'resolveTicketAction' ? 'resolved' : name === 'closeTicketAction' ? 'closed' : 'open';
      expect(write).toMatchObject({ table: 'support_tickets', kind: 'update', payload: { status } });
      expect(write.filters).toContainEqual(['id', 'ticket-1']);
    }
  });
});
