// The push-campaign console's server actions (app/(app)/admin/marketing/push/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. A marketing push reaches every consenting device on the platform,
// across every household, so it is a site-admin decision. Each action opens with
// requireMarketingAdmin (lib/marketing/admin.ts:82-93): a signed-out caller is
// refused 401, anyone not on the super-admin allowlist 403 — a household's parent
// included (lib/marketing/admin.ts:74-79) — and a super admin who owes a two-step
// code 403. marketing_push_campaigns is a platform table with no family column,
// so there is no "other family" id to pass.
//
// THE SEND reaches success here with an empty audience: no enabled push_devices,
// so lib/marketing/push-audience.ts returns no recipients and the provider
// (lib/server/push.ts sendPushToUsers) is never called. Delivery to devices is
// tests/a-stuck-push-campaign-can-be-resolved.test.ts's subject; this file pins
// who may start a send and what the campaign row records.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), sendPushToUsers: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));
vi.mock('@/lib/server/push', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendPushToUsers: h.sendPushToUsers,
}));

const actions = await import('@/app/(app)/admin/marketing/push/actions');

const IDS = { create: 'ACTION-BDE7FD6EF5B1', send: 'ACTION-E7AFDF8C4FA3', remove: 'ACTION-A679BF182948' } as const;
const DRAFT = 'd0000000-0000-4000-8000-000000000001';
const SENT = 'd0000000-0000-4000-8000-000000000002';
const STAMP = '2026-11-01T12:00:00.000Z';

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.sendPushToUsers.mockReset();
  db = newAdminWorld();
  db.seed('marketing_push_campaigns', [
    { id: DRAFT, title: 'Spring tips', body: 'Five ideas', url: '/blog/spring', status: 'draft', metadata: {}, deleted_at: null,
      recipients: 0, sent: 0, failed: 0, skipped: 0, sent_at: null, created_at: STAMP, updated_at: STAMP },
    { id: SENT, title: 'Old news', body: null, url: null, status: 'sent', metadata: { push_delivery: { version: 1, attemptId: 'old', phase: 'complete' } },
      deleted_at: null, recipients: 3, sent: 3, failed: 0, skipped: 0, sent_at: STAMP, created_at: STAMP, updated_at: STAMP },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const audit = () => db.table('marketing_audit_logs').map((r) => [r.action, r.resource, r.resource_id, r.actor_id]);
const campaign = (id: string) => db.table('marketing_push_campaigns').find((r) => r.id === id);

const titleForm = () => {
  const fd = new FormData();
  fd.set('title', 'Back to school');
  fd.set('body', 'Plan the first week');
  fd.set('url', '/blog/back-to-school');
  return fd;
};

const CALLS: [string, () => Promise<unknown>][] = [
  [IDS.create, () => actions.createPushCampaignAction(titleForm())],
  [IDS.send, () => actions.sendPushCampaignAction(DRAFT)],
  [IDS.remove, () => actions.deletePushCampaignAction(DRAFT)],
];

describe('every push action refuses anyone but a site admin, and writes nothing', () => {
  const matrix = CALLS.flatMap(([id, call]) => REFUSED_CALLERS.map((c) => ({ id, call, ...c })));
  it.each(matrix)('$id $label is refused and nothing is written', async ({ call, caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(call()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(h.sendPushToUsers).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('a site admin', () => {
  beforeEach(() => signInAs({ kind: 'super_admin' }));

  it(`${IDS.create} creates one draft campaign`, async () => {
    await actions.createPushCampaignAction(titleForm());
    const created = db.table('marketing_push_campaigns').filter((r) => r.title === 'Back to school');
    expect(created).toEqual([expect.objectContaining({ body: 'Plan the first week', url: '/blog/back-to-school', created_by: SUPER_ADMIN.id })]);
    expect(audit()).toEqual([['create', 'marketing_push_campaign', created[0].id, SUPER_ADMIN.id]]);
  });

  it(`${IDS.send} sends a draft to an empty audience: recorded as sent with no recipients, no provider call`, async () => {
    await actions.sendPushCampaignAction(DRAFT);
    expect(campaign(DRAFT)).toMatchObject({
      status: 'sent', recipients: 0, sent: 0, failed: 0, skipped: 0, sent_at: null,
      metadata: { push_delivery: { version: 1, phase: 'no_recipients', recipientUsers: 0 } },
    });
    expect(h.sendPushToUsers).not.toHaveBeenCalled();
    expect(audit()).toEqual([['send', 'marketing_push_campaign', DRAFT, SUPER_ADMIN.id]]);
  });

  it(`${IDS.send} does not send a campaign that already went out`, async () => {
    const before = snapshot(db);
    await actions.sendPushCampaignAction(SENT);
    expect(snapshot(db)).toEqual(before);
  });

  it(`${IDS.remove} soft-deletes the named campaign only`, async () => {
    await actions.deletePushCampaignAction(DRAFT);
    expect(campaign(DRAFT)?.deleted_at).toEqual(expect.any(String));
    expect(campaign(SENT)?.deleted_at).toBeNull();
    expect(audit()).toEqual([['delete', 'marketing_push_campaign', DRAFT, SUPER_ADMIN.id]]);
  });
});
