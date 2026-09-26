// I18N-003, for the paperwork a family pastes in.
//
// Triage used to write the amount it found on a slip as `$${amount}` — the
// dollar sign as TEXT, the number through toFixed, which has no locale — into
// an English one-line summary, and every place that showed that summary printed
// it as stored. A German parent opening the Paperwork Inbox read
// "… · due 2026-03-03 · $2768.40", where they write "2.768,40 $". One tap on
// "Remind me" then filed a reminder titled "Make the payment ($2768.4) — …",
// and "Add to calendar" copied the stored English summary into the event.
//
// The row is written once and read by every member, so the stored summary is a
// record in the source language (lib/paperwork/triage.ts, RECORD_LOCALE) and
// each place a person reads it re-renders it for THAT person. These cases go
// through the real writer (paperworkInsertRow, the paste action's own payload)
// and the real readers — the Paperwork Inbox card, the household inbox PAGE
// (so the locale it hands the queue loader is the request's, not a hand-built
// one), and the "Remind me" / "Add to calendar" action — and assert what each
// person would see.
//
// THE COPY COMES FROM THE REAL CATALOGUES, with nothing laid under them. The
// paperworkTriage.* keys are asked for in the i18n-asks file and reach
// lib/i18n/messages/*.json when the orchestrator merges them, translated. UNTIL
// THAT MERGE LANDS THESE CASES ARE RED, on purpose: a card showing
// "paperworkTriage.kindPermissionSlip · paperworkTriage.due · 2.768,40 $" is
// exactly what a family would see, and a test that papered over it with its own
// English would pass while every reader saw raw keys.
//
// Every amount is derived from the shared money formatter for an EXPLICIT
// locale, never hand-typed: the claim is "this reader gets their own locale's
// format", and the formatter is what defines that format.
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';
import type { Json, Tables } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  locale: 'en-US' as string,
  db: null as unknown,
  reminders: [] as { title: string; notes?: string | null }[],
}));

// The card's own server actions, router, toasts and camera are not what is
// being read there; the card's text is. The REAL action module is loaded below
// with importActual, and everything it reaches that decides text is real.
vi.mock('@/app/(app)/dashboard/paperwork/actions', () => ({
  addPaperworkAction: vi.fn(), materializePaperworkActionAction: vi.fn(),
  setPaperworkStatusAction: vi.fn(), draftPaperworkReplyAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/capture/document-capture', () => ({ DocumentCapture: () => null }));
// The request's locale, the way a server component or action reads it.
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
    translate(getMessages(h.locale as LocaleCode), key, params),
  getLocaleContext: async () => ({
    locale: localeOrDefault(h.locale), source: 'cookie', messages: getMessages(h.locale as LocaleCode),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = {
    user: { id: 'user-1' },
    active: { familyId: 'family-1', member: { id: 'member-1' }, family: { timezone: 'UTC' }, role: 'parent' },
  };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
// What the action HANDS the reminder service is the text under test.
vi.mock('@/lib/services/reminders', () => ({
  createReminder: vi.fn(async (_scope: unknown, input: { title: string; notes?: string | null }) => {
    h.reminders.push(input);
    return { ok: true, data: { id: `reminder-${h.reminders.length}` } };
  }),
}));
// The inbox page's other half (the Contact Center module) and the queue's
// triage button are not what is being read; the queue's snippets are.
vi.mock('@/components/modules/inbox-module', () => ({ InboxModule: () => null }));
vi.mock('@/app/(app)/dashboard/inbox/actions', () => ({ handleInboxMessageAction: vi.fn() }));

const { PaperworkModule } = await import('@/components/modules/paperwork-module');
const { default: InboxPage } = await import('@/app/(app)/dashboard/inbox/page');
const { paperworkInsertRow, materializePaperworkActionAction } = await vi.importActual<
  typeof import('@/app/(app)/dashboard/paperwork/actions')
>('@/app/(app)/dashboard/paperwork/actions');

/** Intl separates number and symbol (and French thousands) with no-break spaces; compare the words. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

/** The fee on the slip, as the shared formatter writes it for one explicit locale. */
const fee = (code: LocaleCode) => plain(formatCents(276_840, 'USD', code));
const t = (code: LocaleCode, key: string, params?: Record<string, string | number>) =>
  translate(getMessages(code), key, params);

const NOW = new Date('2026-03-01T12:00:00Z');
const SLIP = [
  'Science Museum field trip',
  'Please sign and return the permission slip.',
  'Amount due: $2,768.40 by March 3.',
  'RSVP for the chaperone list by March 3.',
].join('\n');

/** The row exactly as the paste action writes it, as the page reads it back. */
async function storedRow(): Promise<Tables<'paperwork_items'>> {
  const row = await paperworkInsertRow({ familyId: 'family-1', userId: 'user-1', text: SLIP, sender: 'Lincoln Elementary', now: NOW });
  return {
    ...row,
    id: 'p1',
    actions: row.actions as unknown as Json,
    meta: row.meta as unknown as Json,
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-01T09:00:00Z',
  };
}

/** Under the provider the app mounts, with that locale's REAL catalogue. */
function underProvider(code: LocaleCode, child: ReactElement): string {
  return plain(renderToStaticMarkup(createElement(
    LocaleProvider,
    // Same shape tests/helpers/render-translated.ts passes; children go in the third argument.
    { locale: localeOrDefault(code), source: 'default', messages: getMessages(code) } as Parameters<typeof LocaleProvider>[0],
    child,
  )));
}

const renderCard = (items: Tables<'paperwork_items'>[], code: LocaleCode) =>
  underProvider(code, createElement(PaperworkModule, { items }));

/** The copy the English catalogue gives the words on this card — what a German reader must NOT get. */
const englishWordsOnTheCard = () => [
  t('en-US', 'paperworkTriage.kindPermissionSlip'),
  t('en-US', 'paperworkTriage.summarySign'),
  t('en-US', 'paperworkTriage.summaryPay'),
  t('en-US', 'paperworkTriage.actionSign'),
  t('en-US', 'paperworkTriage.actionPay'),
  t('en-US', 'paperworkTriage.due', { date: '2026-03-03' }),
  t('en-US', 'paperworkTriage.by', { date: '2026-03-03' }),
  t('en-US', 'paperworkTriage.from', { sender: 'Lincoln Elementary' }),
];

let db: InMemorySupabase;
beforeEach(() => {
  h.locale = 'en-US';
  h.reminders = [];
  db = createInMemorySupabase();
  h.db = db;
});

describe('the fee formats themselves (a sanity pin on what the cases below compare against)', () => {
  it('are three different strings, and none is the old hand-written one', () => {
    expect(new Set([fee('en-US'), fee('de-DE'), fee('fr-FR')]).size).toBe(3);
    expect(fee('de-DE')).toContain('2.768,40');
    expect(fee('en-US')).toContain('2,768.40');
    for (const code of ['en-US', 'de-DE', 'fr-FR'] as const) expect(fee(code)).not.toBe('$2768.40');
  });
});

describe('a paperwork fee, read by the family member looking at it', () => {
  it('is found on the slip and stored as an en-US record, not as a hand-written "$"', async () => {
    const row = await storedRow();
    expect(row.amount).toBe(2768.4);
    // The record is grouped by Intl now; `$${amount.toFixed(2)}` wrote "$2768.40".
    expect(plain(row.summary ?? '')).toContain(fee('en-US'));
    expect(row.summary).not.toContain('$2768');
  });

  it('reads in German on the Paperwork Inbox card for a German reader — the fee in the summary AND on the payment line, and the words around it', async () => {
    const row = await storedRow();
    const html = renderCard([row], 'de-DE');

    expect(html.split(fee('de-DE')).length - 1, html).toBeGreaterThanOrEqual(2);
    for (const american of ['$2768', '$2,768', '$2.768', '2768.40', '2768.4']) {
      expect(html, `a German reader must not see ${american}`).not.toContain(american);
    }
    // The card does not print the stored English record; it re-renders it.
    expect(html).not.toContain(plain(row.summary ?? ''));
    // Every word came from the German catalogue: no raw key (red until the
    // catalogue merge lands) …
    expect(html).not.toMatch(/paperworkTriage\.\w+/);
    expect(html).toContain(t('de-DE', 'paperworkTriage.by', { date: '2026-03-03' }));
    expect(html).toContain(t('de-DE', 'paperworkTriage.from', { sender: 'Lincoln Elementary' }));
    expect(html).toContain(t('de-DE', 'paperworkTriage.kindPermissionSlip'));
    // … and not the English source text either, which is what an untranslated
    // merge would show a German reader around a correctly formatted number.
    for (const english of englishWordsOnTheCard()) {
      expect(html, `a German reader must not read the English "${english}"`).not.toContain(english);
    }
  });

  it('reads the English sentence with "$2,768.40" for an American reader of the same row', async () => {
    const html = renderCard([await storedRow()], 'en-US');
    expect(html.split(fee('en-US')).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(fee('de-DE'));
    // Red until the catalogue merge lands: these words come from en-US.json.
    expect(html).toContain(`Permission slip · sign and return + make the payment · due 2026-03-03 · ${fee('en-US')} · from Lincoln Elementary`);
    expect(html).toContain(`Make the payment · ${fee('en-US')} · by 2026-03-03`);
  });

  it('reads the French format for a French reader', async () => {
    const html = renderCard([await storedRow()], 'fr-FR');
    expect(html).toContain(fee('fr-FR'));
    expect(html).not.toContain(fee('en-US'));
  });

  it('is re-rendered for the request\'s reader on the household inbox page, not only when a test hands the loader a reader', async () => {
    const row = await storedRow();
    db.seed('paperwork_items', [row]);
    const pageFor = async (code: LocaleCode) => {
      h.locale = code;
      return underProvider(code, (await InboxPage()) as ReactElement);
    };

    const german = await pageFor('de-DE');
    expect(german).toContain(fee('de-DE'));
    expect(german).not.toContain(fee('en-US'));
    expect(german).not.toContain('$2768');
    expect(german).toContain(t('de-DE', 'paperworkTriage.kindPermissionSlip'));
    expect(german).not.toContain(t('en-US', 'paperworkTriage.kindPermissionSlip'));
    expect(german).not.toMatch(/paperworkTriage\.\w+/);

    const american = await pageFor('en-US');
    expect(american).toContain(`Permission slip · sign and return + make the payment · due 2026-03-03 · ${fee('en-US')}`);
    expect(american).not.toContain(fee('de-DE'));
  });
});

describe('what "Remind me" and "Add to calendar" file for the member who tapped them', () => {
  const actionIndex = async (kind: string) => {
    const row = await storedRow();
    db.seed('paperwork_items', [row]);
    const index = (row.actions as { kind: string }[]).findIndex((a) => a.kind === kind);
    expect(index, `the slip yields a ${kind} action`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('titles a German member\'s payment reminder with the fee in their format and their words', async () => {
    const index = await actionIndex('pay');
    h.locale = 'de-DE';
    await materializePaperworkActionAction({ itemId: 'p1', actionIndex: index });

    expect(h.reminders).toHaveLength(1);
    const { title, notes } = h.reminders[0]!;
    const shown = plain(`${title} ${notes ?? ''}`);
    expect(shown).toContain(fee('de-DE'));
    expect(shown).toContain('Science Museum field trip');
    expect(shown).toContain(t('de-DE', 'paperworkTriage.actionPay'));
    expect(shown).toContain(t('de-DE', 'paperworkTriage.due', { date: '2026-03-03' }));
    expect(shown).toContain('Lincoln Elementary');
    for (const wrong of ['$2768', '$2,768', t('en-US', 'paperworkTriage.actionPay'), t('en-US', 'paperworkTriage.fromPaperworkInbox')]) {
      expect(shown, `a German member must not read ${wrong}`).not.toContain(wrong);
    }
    expect(shown).not.toMatch(/paperworkTriage\.\w+/);
  });

  it('titles an American member\'s payment reminder "Make the payment ($2,768.40) — …", not "($2768.4)"', async () => {
    const index = await actionIndex('pay');
    await materializePaperworkActionAction({ itemId: 'p1', actionIndex: index });

    // Red until the catalogue merge lands: these words come from en-US.json.
    expect(plain(h.reminders[0]!.title)).toBe(`Make the payment (${fee('en-US')}) — Science Museum field trip`);
    expect(h.reminders[0]!.notes).toBe('From Paperwork Inbox · Lincoln Elementary · due 2026-03-03');
  });

  it('writes a German member\'s calendar event from the row, not the stored English record', async () => {
    const row = await storedRow();
    const index = await actionIndex('rsvp');
    h.locale = 'de-DE';
    await materializePaperworkActionAction({ itemId: 'p1', actionIndex: index });

    const [event] = db.table('calendar_events');
    const description = plain(String(event?.description ?? ''));
    expect(description).toContain(fee('de-DE'));
    expect(description).not.toContain(plain(row.summary ?? ''));
    expect(description).not.toContain(fee('en-US'));
    expect(description).toContain(t('de-DE', 'paperworkTriage.kindPermissionSlip'));
    for (const english of [t('en-US', 'paperworkTriage.fromPaperworkInbox'), t('en-US', 'paperworkTriage.kindPermissionSlip')]) {
      expect(description, `a German member must not read the English "${english}"`).not.toContain(english);
    }
    expect(description).not.toMatch(/paperworkTriage\.\w+/);
  });

  it('writes an American member\'s calendar event in English with "$2,768.40"', async () => {
    const index = await actionIndex('rsvp');
    await materializePaperworkActionAction({ itemId: 'p1', actionIndex: index });

    // Red until the catalogue merge lands: these words come from en-US.json.
    expect(plain(String(db.table('calendar_events')[0]?.description ?? ''))).toBe(
      `From Paperwork Inbox — RSVP. Permission slip · sign and return + make the payment · due 2026-03-03 · ${fee('en-US')}`,
    );
  });
});
