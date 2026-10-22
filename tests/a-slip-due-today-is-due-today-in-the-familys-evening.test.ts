// S3 — paperwork triage read a slip's yearless due date on Greenwich's day.
//
// "Sign and return by 10/13" carries no year, so triage infers one, rolling a
// date already past to next year, and counts the days left for urgency. Both
// were measured from the UTC day of a bare server instant, and every writer
// passed one. For a Los Angeles family going through the school bag at 18:00
// PDT on October 13 — 01:00Z on the 14th — the deadline that is TODAY was
// filed as due 2027-10-13 at urgency 'normal': sorted to the bottom of the
// inbox with no urgent badge, and "Add to calendar" put it a year out.
//
// Driven through the three writers a family meets: the paste action, the
// inbound email filer and the email-attachment filer, each for a household in
// Los Angeles at that hour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-la';
const TZ = 'America/Los_Angeles';
/** 18:00 PDT on Tuesday 2026-10-13: already the 14th at Greenwich. */
const EVENING = new Date('2026-10-14T01:00:00Z');
const SLIP = 'Lincoln Elementary field trip permission slip\nPlease sign and return by 10/13.';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: getMessages('en-US') }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'parent-user' },
    active: { familyId: 'family-la', role: 'parent', member: { id: 'm-mom' }, family: { timezone: 'America/Los_Angeles' } },
  }),
}));

const { addPaperworkAction } = await import('@/app/(app)/dashboard/paperwork/actions');
const { fileInboundPaperwork } = await import('@/lib/contact-center/server');
const { fileEmailAttachments } = await import('@/lib/services/paperwork/email-attachments');

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase({ defaults: { paperwork_items: { status: 'needs_action', actions: [], meta: {} } } });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: TZ }]);
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
});
afterEach(() => { vi.useRealTimers(); });

const filed = () => db.table('paperwork_items').map((row) => ({ due_on: row.due_on, urgency: row.urgency }));

describe('a slip due today, filed on the family\'s evening, is due today', () => {
  it('pasted into the Paperwork Inbox', async () => {
    const form = new FormData();
    form.set('text', SLIP);

    expect(await addPaperworkAction(form)).toEqual({ ok: true });

    expect(filed()).toEqual([{ due_on: '2026-10-13', urgency: 'urgent' }]);
  });

  it('arriving by email to the household address', async () => {
    const id = await fileInboundPaperwork(db as never, FAMILY, SLIP, EVENING, 'email-ref-1', 'office@lincoln.example');

    expect(id).toBeTruthy();
    expect(filed()).toEqual([{ due_on: '2026-10-13', urgency: 'urgent' }]);
  });

  it('arriving as an email attachment', async () => {
    db.seed('family_inbox_messages', [{ id: 'msg-1', family_id: FAMILY, channel: 'email', provider_ref: 'email-ref-2' }]);

    const result = await fileEmailAttachments(db as unknown as SupabaseClient<Database>, {
      familyId: FAMILY, inboxMessageId: 'msg-1', providerRef: 'email-ref-2', sender: 'office@lincoln.example', subject: 'Slip',
      files: [new File(['%PDF-1.7\nslip'], 'slip.pdf', { type: 'application/pdf' })],
    }, {
      now: EVENING,
      extract: (async () => ({ ok: true, text: SLIP, truncated: false })) as never,
      enrich: async () => ({ ok: true, data: null }),
    });

    expect(result).toMatchObject({ ok: true, results: [{ status: 'filed' }] });
    expect(filed()).toEqual([{ due_on: '2026-10-13', urgency: 'urgent' }]);
  });

  it('and a slip due tomorrow is still due tomorrow, not today', async () => {
    const form = new FormData();
    form.set('text', 'Science fair permission slip\nPlease sign and return by October 14.');

    expect(await addPaperworkAction(form)).toEqual({ ok: true });

    expect(filed()).toEqual([{ due_on: '2026-10-14', urgency: 'urgent' }]);
  });
});
