// AQ-01 / I18N-003, the engines-last group: the money-approval reminders
// (lib/notifications/approval-reminders.ts) and the concierge digest's canonical
// text (lib/concierge/digest.ts).
//
// Both wrote the currency symbol as TEXT —
//
//   `$${v.toFixed(2)}`        `$${amount.toFixed(2)}`
//
// — so an amount came out as "$2768.50": the American symbol position, no
// grouping, and for the reminders inside an English sentence, so localising the
// number alone would have changed nothing a German parent could read.
//
// WHAT THIS CHANGE IS, AND IS NOT. For the two reminder builders it is
// GROUNDWORK: the English prose moved into the catalogue (approvalReminders.*,
// aiApprovalReminders.*, the needsSources.* labels), the hand-written symbol
// went, and each builder now REQUIRES a reader. It is NOT a conversion of
// either site. Both writers are sweeps — generateFamilyNotifications
// (lib/server/notifications.ts) and remindPendingApprovals
// (lib/services/approvals/index.ts) — that write one row per manager with no
// recipient locale to read, because no member or family table stores a
// language choice (I18N-001), and `notifications` has no facts column a screen
// could re-word from (0002_tables.sql: title, body, related_type, related_id).
// So the only reader either builder ever receives today is an explicit,
// commented 'en-US' constant, and EVERY manager — a German one included — still
// finds the English sentence with the American amount in the bell
// (notifications-module) and in push. Those are the two surfaces: both builders
// emit type 'system', which lib/notifications/priority.ts routes to 'now', so
// these rows never reach the brief's "Also today". Until a per-recipient locale
// exists the visible difference for anyone is en-US thousands grouping
// ("$2768.50" → "$2,768.50").
//
// WHAT EACH BLOCK BELOW PROVES, THEREFORE.
//  - The de-DE reminder cases hand the builders a German reader that NO
//    production caller supplies yet. They pin that the builders are READY —
//    the amount in the reader's format and no English left around it — so the
//    day a locale column lands, wiring it is one line at each call site. They
//    do not describe what a German parent sees today.
//  - The en-US reminder cases pin the catalogue's English sentence, which is
//    what every manager is stored today.
//  - The cron case runs the real sweep over the in-memory Supabase and pins the
//    en-US sentence it STORES, so the residual is on the record, not assumed.
//  - The digest block is the one site that IS closed: its canonical text is a
//    record (the model's grounding via digestToPromptLines, and the reference
//    digest-display.ts recomputes to reject stale presentation facts), and the
//    family already read the digest through formatConciergeDigest(digest,
//    locale, t). Of its three cases only the canonical-record one depends on
//    this change; the two display cases are GUARDS — they passed before it and
//    must still pass after, because the display layer only re-words an item
//    whose stored detail still equals the canonical text, so a record now
//    grouped as "$2,768.50" has to keep matching itself.
//
// RED UNTIL THE CATALOGUE MERGE LANDS. The sentences come from the REAL
// catalogues — no English floor layered under them — and the keys are asked for
// in the orchestrator's i18n asks (engines-last.json). Until they are merged a
// key renders as itself, and the reminder cases below fail on it: that is the
// point. A test that filled the gap with its own English would pass on a title
// that reads "approvalReminders.titleWithAmount". The merge must carry real
// de-DE translations: ownSentence() rejects English copied into de-DE.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database.types';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';
import { approvalReminders, aiApprovalReminders } from '@/lib/notifications/approval-reminders';
import { buildConciergeDigest, digestToPromptLines } from '@/lib/concierge/digest';
import { formatConciergeDigest } from '@/lib/concierge/digest-display';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// ── The catalogue half ───────────────────────────────────────────────────────
// Every sentence this unit moved into the catalogue, in the English it asked for.
const ASKED_ENGLISH: Record<string, string> = {
  'approvalReminders.title': 'Approval needed: {label}',
  'approvalReminders.titleWithAmount': 'Approval needed: {label} · {amount}',
  'approvalReminders.body': 'A family member is waiting — tap to review in Family Wallet.',
  'aiApprovalReminders.title': 'Needs your OK: {title}',
  'aiApprovalReminders.titleWithAmount': 'Needs your OK: {title} · {amount}',
  'aiApprovalReminders.waiting': 'Bubaly is waiting for your OK before it goes ahead.',
  'aiApprovalReminders.waitingAgent': 'Bubaly is waiting for your OK before it goes ahead ({agent}).',
  'aiApprovalReminders.expiresWithinHour': 'Expires within the hour',
  'aiApprovalReminders.expiresInHours': 'Expires in {hours}h',
  'aiApprovalReminders.expiresInDays': 'Expires in {days} days',
};
// The wallet kinds' labels belong to Home's "Needs you" list; this file needs only that German has them.
const BORROWED_KEYS = ['needsSources.cardPurchase', 'needsSources.allowanceRequest', 'needsSources.approval'];

const readerFor = (code: LocaleCode) => ({
  locale: code,
  t: (key: string, params?: Record<string, string | number>) => translate(getMessages(code), key, params),
});

/**
 * `key` as the locale's OWN catalogue words it: present in that locale's file
 * rather than inherited from en-US, and — for any locale but en-US — not the
 * English copied across.
 */
function ownSentence(locale: LocaleCode, key: string): string {
  const own = getRawMessages(locale)[key];
  expect(own, `${locale} carries its own "${key}"`).toBeTruthy();
  if (locale !== 'en-US') {
    expect(own, `${locale}'s "${key}" is translated, not the English`).not.toBe(getRawMessages('en-US')[key]);
  }
  return own;
}

// ── The money half ───────────────────────────────────────────────────────────
/** What the shared formatter (lib/wallet/ledger.ts) writes for USD in `locale` — its own answer, not a typed literal. */
const usd = (cents: number, locale: LocaleCode) => formatCents(cents, 'USD', locale);
/** Intl puts a NO-BREAK SPACE between a German amount and its symbol; compare as plain text. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');
/** Every American rendering of 2768.50 the old code could produce. */
const AMERICAN = ['$2,768.50', '$2768.50', '$2769', '$2,769'];
const CENTS = 276850;
const expectGerman = (text: string | null) => {
  expect(text).not.toBeNull();
  expect(plain(text!)).toContain(plain(usd(CENTS, 'de-DE')));
  for (const us of AMERICAN) expect(plain(text!)).not.toContain(us);
};
/** And no English sentence left around it. */
const expectNoEnglish = (text: string | null, ...english: string[]) => {
  for (const words of english) expect(plain(text ?? ''), `"${words}" is English left on a German screen`).not.toContain(words);
};
/** A key rendered as itself is the failure this file exists to catch. */
const expectNoRawKey = (text: string | null) => {
  expect(text ?? '').not.toMatch(/(?:approvalReminders|aiApprovalReminders|needsSources|conciergeDisplay)\./);
};

const NOW = new Date('2026-09-26T12:00:00.000Z');
const managers = [{ id: 'm1', user_id: 'u1' }];

describe('the reader locale really spells money differently', () => {
  it('de-DE and en-US disagree on 2768.50', () => {
    expect(plain(usd(CENTS, 'de-DE'))).not.toBe(usd(CENTS, 'en-US'));
    expect(usd(CENTS, 'en-US')).toBe('$2,768.50');
  });
});

describe('the catalogue holds every sentence this unit moved into it', () => {
  it.each(Object.entries(ASKED_ENGLISH))('en-US says %s as "%s"', (key, english) => {
    expect(getRawMessages('en-US')[key]).toBe(english);
  });
  it.each([...Object.keys(ASKED_ENGLISH), ...BORROWED_KEYS])('de-DE carries its own %s', (key) => {
    ownSentence('de-DE', key);
  });
});

// ── The wallet inbox (parent_approvals) ──────────────────────────────────────
describe('a pending card purchase, worded for its reader', () => {
  const pending = [{ id: 'a1', kind: 'card_spend', amount_cents: CENTS, created_at: 'x' }];

  it('is worded for a de-DE reader — "… 2.768,50 $", the German label, no English around it — though no caller supplies one yet', () => {
    const [row] = approvalReminders(pending, managers, readerFor('de-DE'));
    expectGerman(row.title);
    expect(row.title).toContain(ownSentence('de-DE', 'needsSources.cardPurchase'));
    expectNoEnglish(row.title, 'Approval needed', 'Card purchase');
    expectNoRawKey(row.title);
    // "Family Wallet" is the product's name and stays as it is in German — de-DE
    // already says "Die Family Wallet konnte nicht aktiviert werden" — so it is
    // not English to reject here; the sentence around it is.
    expectNoEnglish(row.body, 'A family member is waiting', 'tap to review');
    expectNoRawKey(row.body);
  });

  it('is worded from the catalogue for an en-US reader — the sentence every manager is stored today', () => {
    const [row] = approvalReminders(pending, managers, readerFor('en-US'));
    expect(row.title).toBe(`Approval needed: Card purchase · ${usd(CENTS, 'en-US')}`);
    expect(row.body).toBe('A family member is waiting — tap to review in Family Wallet.');
    // A whole-dollar amount keeps the compact form the wallet always used.
    const [whole] = approvalReminders([{ ...pending[0], amount_cents: 2500 }], managers, readerFor('en-US'));
    expect(whole.title).toBe('Approval needed: Card purchase · $25');
  });

  it('an unknown kind with no amount is still worded in the reader\'s language', () => {
    const [row] = approvalReminders([{ id: 'a2', kind: 'mystery', amount_cents: null, created_at: 'x' }], managers, readerFor('de-DE'));
    expect(row.title).toContain(ownSentence('de-DE', 'needsSources.approval'));
    expectNoEnglish(row.title, 'Approval needed');
    expectNoRawKey(row.title);
    expect(row.title).not.toContain('$');
  });
});

// ── The trust-engine inbox (approval_requests) ───────────────────────────────
describe('a pending AI approval with an amount, worded for its reader', () => {
  const pending = [{ id: 'appr-1', title: 'Add soccer Saturday', amount_cents: CENTS, created_at: 'x', expires_at: '2026-09-28T12:00:00.000Z', agent: 'concierge' }];

  it('is worded for a de-DE reader — "… 2.768,50 $", the planner\'s own title kept, no English around it — though no caller supplies one yet', () => {
    const [row] = aiApprovalReminders(pending, managers, readerFor('de-DE'), NOW);
    expectGerman(row.title);
    // The planner wrote this title; it is data, not a sentence of ours to translate.
    expect(row.title).toContain('Add soccer Saturday');
    expectNoEnglish(row.title, 'Needs your OK');
    expectNoRawKey(row.title);
    expect(row.body).toContain('concierge');
    expectNoEnglish(row.body, 'waiting for your OK', 'goes ahead', 'Expires in');
    expectNoRawKey(row.body);
  });

  it('is worded from the catalogue for an en-US reader — the sentences every manager is stored today', () => {
    const [row] = aiApprovalReminders(pending, managers, readerFor('en-US'), NOW);
    expect(row.title).toBe(`Needs your OK: Add soccer Saturday · ${usd(CENTS, 'en-US')}`);
    expect(row.body).toBe('Bubaly is waiting for your OK before it goes ahead (concierge). Expires in 2 days');
    const [soon] = aiApprovalReminders([{ ...pending[0], agent: null, expires_at: '2026-09-26T20:00:00.000Z' }], managers, readerFor('en-US'), NOW);
    expect(soon.body).toBe('Bubaly is waiting for your OK before it goes ahead. Expires in 8h');
    const [imminent] = aiApprovalReminders([{ ...pending[0], agent: null, expires_at: '2026-09-26T12:30:00.000Z' }], managers, readerFor('en-US'), NOW);
    expect(imminent.body).toBe('Bubaly is waiting for your OK before it goes ahead. Expires within the hour');
  });
});

// ── The cron that writes them ────────────────────────────────────────────────
// remindPendingApprovals has no reader to name (a cron, no request, no stored
// locale) and says so where it passes 'en-US'. What it STORES — for every
// manager, the German one included — is therefore the English sentence with the
// American amount. Pinned, so the residual is on the record until I18N-001.
type DB = SupabaseClient<Database>;
const holder = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => undefined, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({ executeTool: async () => ({ status: 'denied', reason: 'not in this test', toolCallId: null }) }));
const { remindPendingApprovals } = await import('@/lib/services/approvals');

beforeEach(() => { holder.service = null; });

describe('the reminder sweep, which has no reader to name', () => {
  it('stores the en-US sentence, explicitly, for every manager — the residual until a per-recipient locale exists', async () => {
    const db = createInMemorySupabase<DB>();
    db.seed('approval_requests', [{
      id: 'appr-1', family_id: 'fam-1', status: 'pending', requested_by_kind: 'ai', title: 'Add soccer Saturday',
      amount_cents: CENTS, created_at: 'x', expires_at: '2026-09-28T12:00:00.000Z', agent: 'concierge',
    }]);
    db.seed('families', [{ id: 'fam-1', timezone: 'Europe/Berlin' }]);
    db.seed('family_members', [
      { id: 'm1', family_id: 'fam-1', user_id: 'u1', role: 'parent', is_active: true },
      { id: 'm3', family_id: 'fam-1', user_id: 'u3', role: 'teen', is_active: true },
    ]);
    holder.service = db;

    const result = await remindPendingApprovals(db as unknown as DB, NOW);
    expect(result).toEqual({ reminded: 1, families: 1 });
    const rows = db.table('notifications');
    expect(rows.map((r) => r.user_id)).toEqual(['u1']);
    expect(rows[0].title).toBe(`Needs your OK: Add soccer Saturday · ${usd(CENTS, 'en-US')}`);
    expect(rows[0].title).not.toContain('$2768.50');
    expect(rows[0].body).toBe('Bubaly is waiting for your OK before it goes ahead (concierge). Expires in 2 days');
  });
});

// ── The concierge digest ─────────────────────────────────────────────────────
describe('a bill in the concierge digest', () => {
  // Due tomorrow, for a family whose day is Greenwich's.
  const digest = () => buildConciergeDigest({ now: NOW, bills: [{ name: 'Strom', amount: CENTS / 100, dueDate: '2026-09-27' }] });
  const viewFor = (code: LocaleCode) => {
    const { locale, t } = readerFor(code);
    return formatConciergeDigest(digest(), locale, t);
  };

  it('GUARD (passes before and after this change): reads "2.768,50 $ … morgen" to a German parent through the display layer, with no English around it', () => {
    const [item] = viewFor('de-DE').items;
    expectGerman(item.detail);
    expect(item.detail).toContain('morgen');
    expectNoEnglish(item.detail, 'due', 'tomorrow');
    expectNoRawKey(item.detail);
    expect(item.title).toBe('Strom');
  });

  it('GUARD (passes before and after this change): reads the catalogue\'s English sentence to an American parent', () => {
    const [item] = viewFor('en-US').items;
    expect(item.detail).toBe(`${usd(CENTS, 'en-US')} due tomorrow`);
  });

  it('writes its canonical record — the model\'s grounding — with the same Intl call in the source locale, not by hand', () => {
    const lines = digestToPromptLines(digest());
    expect(lines).toContain(`Strom — ${usd(CENTS, 'en-US')} due tomorrow`);
    expect(lines).not.toContain('$2768.50');
  });
});
