// S6 / S16 — the household inbox listed every member's paperwork.
//
// Paperwork is a parent's or adult's, and whoever added an item keeps reading
// it (the held 0514, lib/finance/household-money.ts: "the same rule holds
// before and after 0514 is released; … the screen shows the same ones"). The
// Paperwork Inbox and Needs-you pages narrow a non-manager to created_by = self
// before their limits. /dashboard/inbox did not: loadInboxQueue read the whole
// family's open paperwork, so a teen, a child or a caregiver was shown the
// parents' medical forms, bills and permission slips — title, a summary with
// the amount, the due date — and handed each row id.
//
// Driven through the real page, rendered under the app's locale provider.
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'teen', userId: 'teen-user' }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = () => ({
    user: { id: h.userId },
    active: { familyId: 'family-1', member: { id: `member-${h.userId}` }, family: { timezone: 'UTC' }, role: h.role },
  });
  return { requireUserContext: async () => ctx(), requireFeature: async () => ctx() };
});
// The page's other half (the Contact Center module) and the queue's triage
// button are not what is being read; the queue is.
vi.mock('@/components/modules/inbox-module', () => ({ InboxModule: () => null }));
vi.mock('@/app/(app)/dashboard/inbox/actions', () => ({ handleInboxMessageAction: vi.fn() }));

const { default: InboxPage } = await import('@/app/(app)/dashboard/inbox/page');
const { InboxQueue } = await import('@/components/modules/inbox-queue');

/** The props the page hands the client queue: what crosses to the member's browser. */
function queueProps(node: unknown): { items: { rowId: string }[] } | null {
  if (!isValidElement<Record<string, unknown>>(node)) return Array.isArray(node) ? node.map(queueProps).find(Boolean) ?? null : null;
  if (node.type === InboxQueue) return node.props as { items: { rowId: string }[] };
  return queueProps(node.props.children);
}

async function inboxAs(role: string, userId: string): Promise<{ html: string; rowIds: string[] }> {
  h.role = role;
  h.userId = userId;
  const page = (await InboxPage()) as ReactElement;
  const html = renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'default', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    page,
  ));
  return { html, rowIds: (queueProps(page)?.items ?? []).map((item) => item.rowId) };
}

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('paperwork_items', [
    {
      id: 'pw-parents-form', family_id: 'family-1', kind: 'medical_form', title: 'Psychiatric intake questionnaire',
      summary: 'Medical form', sender: 'Clinic', due_on: '2026-10-20', urgency: 'soon', status: 'needs_action',
      actions: [{ kind: 'pay' }], amount: 640, meta: {}, created_by: 'parent-user', created_at: '2026-10-10T09:00:00Z',
    },
    {
      id: 'pw-teens-slip', family_id: 'family-1', kind: 'permission_slip', title: 'Band trip permission slip',
      summary: 'Permission slip', sender: 'School', due_on: '2026-10-16', urgency: 'urgent', status: 'needs_action',
      actions: [{ kind: 'sign' }], amount: null, meta: {}, created_by: 'teen-user', created_at: '2026-10-11T09:00:00Z',
    },
  ]);
});

describe('the household inbox shows a member the paperwork they may read', () => {
  it.each([['teen', 'teen-user'], ['child', 'teen-user'], ['caregiver', 'teen-user']])(
    'a %s sees what they added and nothing a parent filed — not its title, amount or row id',
    async (role, userId) => {
      const { html, rowIds } = await inboxAs(role, userId);

      expect(html).toContain('Band trip permission slip');
      expect(html).not.toContain('Psychiatric intake questionnaire');
      expect(html).not.toContain('$640');
      expect(rowIds).toEqual(['pw-teens-slip']);
    },
  );

  it.each(['parent', 'adult'])('a %s still sees the household\'s paperwork', async (role) => {
    const { html, rowIds } = await inboxAs(role, 'parent-user');

    expect(html).toContain('Psychiatric intake questionnaire');
    expect(html).toContain('Band trip permission slip');
    // What the cases above hold back is really on this screen: the amount, and the row id the queue is handed.
    expect(html).toContain('$640');
    expect(rowIds.sort()).toEqual(['pw-parents-form', 'pw-teens-slip']);
  });
});
