import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The email campaign Send button asks GET /api/admin/marketing/email/send for
// the recipient count before it confirms. It read `pj.recipients ?? 0` and
// never looked at the answer's status or error, so a campaign read that
// failed (the route's 500 "Could not load campaign recipients.") became
// "No eligible recipients were found. Send anyway?" and then the toast "No
// eligible recipients." (review R9-SEND-CAMPAIGN-FAILED-PREFLIGHT-IS-NO-RECIPIENTS).
// It now shows the route's answer and asks nothing. The REAL button (hooks as
// slots) whose preflight reaches the REAL route handler over the in-memory
// database; the send itself is only recorded.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));

const { SendCampaignButton } = await import('@/components/admin/send-campaign-button');
const { GET } = await import('@/app/api/admin/marketing/email/send/route');

let db: InMemorySupabase;
let faulted = 0;
let confirms: string[] = [];
let sends: unknown[] = [];
let network: 'route' | 'down' = 'route';

function seed() {
  db.seed('marketing_email_campaigns', [{ id: 'cmp-1', name: 'Autumn', segment_id: null, status: 'draft', deleted_at: null }]);
  db.seed('families', [1, 2, 3].map((k) => ({ id: `fam-${k}`, name: `Family ${k}`, created_at: `2026-0${k}-01T00:00:00.000Z`, updated_at: null, closed_at: null })));
  db.seed('family_members', [1, 2, 3].map((k) => ({ id: `mem-${k}`, family_id: `fam-${k}`, user_id: `user-${k}`, role: 'parent', is_active: true })));
  db.seed('profiles', [1, 2, 3].map((k) => ({ id: `user-${k}`, email: `parent${k}@example.com` })));
  for (const table of ['subscriptions', 'marketing_suppressions']) db.seed(table, []);
}
function failCampaignRead() {
  h.db = withFaults(db, (table) => {
    if (table !== 'marketing_email_campaigns') return null;
    faulted += 1;
    return { message: 'marketing_email_campaigns unavailable' };
  });
}
async function pressSend() {
  resetHookSlots(h.hooks);
  const element = createElement(SendCampaignButton, { id: 'cmp-1' });
  await click(byName(render(h.hooks, element), /Send/, 'button'));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.toasts = { success: [], error: [] };
  faulted = 0;
  confirms = [];
  sends = [];
  network = 'route';
  vi.stubGlobal('window', { confirm: (message: string) => { confirms.push(message); return true; } });
  // The preflight goes to the real route handler; the send is only recorded.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (network === 'down') throw new TypeError('Failed to fetch');
    if (init?.method === 'POST') {
      sends.push(JSON.parse(String(init.body)));
      return Response.json({ sent: 3 });
    }
    return GET(new NextRequest(new URL(url, 'https://www.bubaly.com')));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a recipient count that could not be read is not "no recipients"', () => {
  it('a campaign read that FAILS shows the route\'s answer, asks nothing and sends nothing', async () => {
    seed();
    failCampaignRead();
    await pressSend();
    expect(faulted).toBe(1);
    expect(h.toasts.error).toEqual([SOURCE_MESSAGES['send.couldNotLoadCampaignRecipients']]);
    expect(h.toasts.error).not.toContain(SOURCE_MESSAGES['sendCampaignButton.noEligibleRecipients']);
    expect(confirms).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('a preflight that never answers says the count could not be loaded, not "no recipients"', async () => {
    seed();
    network = 'down';
    await pressSend();
    expect(h.toasts.error).toEqual([SOURCE_MESSAGES['send.couldNotLoadCampaignRecipients']]);
    expect(confirms).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('the control: a count that answers is confirmed with that count and sent', async () => {
    seed();
    await pressSend();
    expect(confirms).toEqual([translate(SOURCE_MESSAGES, 'sendCampaignButton.confirmMany', { n: 3 })]);
    expect(sends).toEqual([{ id: 'cmp-1' }]);
    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([translate(SOURCE_MESSAGES, 'sendCampaign.sentToRecipientsMany', { count: 3 })]);
  });

  it('the control: an audience that really is empty is still "no recipients", and nothing is sent', async () => {
    seed();
    db.replace('family_members', []);
    await pressSend();
    expect(confirms).toEqual([SOURCE_MESSAGES['sendCampaignButton.noRecipientsSendAnyway']]);
    expect(h.toasts.error).toEqual([SOURCE_MESSAGES['sendCampaignButton.noEligibleRecipients']]);
    expect(sends).toEqual([]);
  });
});
