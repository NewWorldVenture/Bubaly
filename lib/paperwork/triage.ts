// lib/paperwork/triage.ts — the Paperwork Inbox brain (pure, tested).
//
// Takes the raw text of a form / flyer / permission slip / school notice and
// triages it: classifies the KIND of paperwork, extracts the ACTION ITEMS a
// parent actually has to do (sign, pay, RSVP, schedule, provide), pulls DUE
// DATES and DOLLAR AMOUNTS out of the prose, and ranks urgency. Heuristic and
// deterministic — no model call — so it runs free and instant; an AI provider
// (when configured) can only ADD richer summaries on top, never replace this.
// No Supabase / React imports; everything here is unit-tested.

import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

export type PaperworkKind =
  | 'permission_slip' | 'school_notice' | 'medical_form' | 'sports'
  | 'bill_or_payment' | 'event_flyer' | 'receipt' | 'reservation' | 'other';

/**
 * The values `paperwork_items.kind` actually admits — the CHECK constraint in
 * `supabase/migrations/0169_paperwork_items.sql` predates 'receipt' and
 * 'reservation' and cannot be widened without a migration.
 */
export const STORED_PAPERWORK_KINDS = [
  'permission_slip', 'school_notice', 'medical_form', 'sports',
  'bill_or_payment', 'event_flyer', 'other',
] as const;

export type StoredPaperworkKind = (typeof STORED_PAPERWORK_KINDS)[number];

/**
 * Triage recognises finer kinds than the column stores. Rather than write a
 * value the CHECK would reject (a 23514 that loses the whole row), a receipt is
 * stored as the payment kind and a reservation as the event kind, and the finer
 * kind is preserved in `paperwork_items.meta` — an existing jsonb column — so
 * nothing is lost and the column can be widened later without re-triaging.
 */
const STORED_KIND_FALLBACK: Record<PaperworkKind, StoredPaperworkKind> = {
  permission_slip: 'permission_slip',
  school_notice: 'school_notice',
  medical_form: 'medical_form',
  sports: 'sports',
  bill_or_payment: 'bill_or_payment',
  event_flyer: 'event_flyer',
  receipt: 'bill_or_payment',
  reservation: 'event_flyer',
  other: 'other',
};

export function storedPaperworkKind(kind: PaperworkKind): StoredPaperworkKind {
  return STORED_KIND_FALLBACK[kind] ?? 'other';
}

/**
 * What to insert into `paperwork_items` for a triaged kind: the admitted column
 * value, plus the meta that remembers what triage actually saw.
 */
export function paperworkKindFields(kind: PaperworkKind): { kind: StoredPaperworkKind; meta: { triage_kind: PaperworkKind } } {
  return { kind: storedPaperworkKind(kind), meta: { triage_kind: kind } };
}

export type PaperworkActionKind = 'sign' | 'pay' | 'rsvp' | 'schedule' | 'provide' | 'review';

export interface PaperworkAction {
  kind: PaperworkActionKind;
  label: string;                 // human phrasing, e.g. "Sign and return the slip"
  due_on: string | null;         // YYYY-MM-DD if a date was found
  amount: number | null;         // dollars if a payment was found
}

export type Urgency = 'urgent' | 'soon' | 'normal';

export interface TriageResult {
  kind: PaperworkKind;
  title: string;                 // best-effort short title
  summary: string;               // one-line plain-language gist
  due_on: string | null;         // the earliest due date found
  amount: number | null;         // the largest amount found
  actions: PaperworkAction[];
  urgency: Urgency;
}

// ── Classification ───────────────────────────────────────────────────────────
const KIND_SIGNALS: [PaperworkKind, RegExp][] = [
  ['permission_slip', /permission slip|field trip|consent form|parent.guardian (signature|consent)|sign and return/i],
  ['medical_form',    /immunization|vaccin|physical exam|medical (form|record|history)|allerg|medication authorization|health form/i],
  ['sports',          /practice schedule|tryout|jersey|uniform|team (fee|schedule)|league|tournament|game day|coach/i],
  // Receipt before bill: "thank you for your order" is money already spent, and
  // filing it as a bill would put a payment on the family's to-do list twice.
  ['receipt',         /receipt|thank you for your (order|purchase|payment)|order confirmation|payment (received|confirmed|successful)|paid in full|transaction id|total charged|charged to your (card|account)|refund issued/i],
  // Reservation before flyer: a confirmed booking is a commitment with a time,
  // not an invitation to consider.
  ['reservation',     /reservation|booking (confirmation|reference|number)|confirmation (number|code)|table for \d|your (table|room|seat) is|check.?in (date|time)|itinerary|boarding pass|reserved for/i],
  ['bill_or_payment', /invoice|amount due|balance due|payment (due|of)|pay online|late fee|tuition|\$\s?\d+(\.\d{2})?\s*(due|owed)/i],
  ['event_flyer',     /join us|you'?re invited|save the date|rsvp|open house|book fair|fundraiser|carnival|concert|performance/i],
  ['school_notice',   /school|classroom|teacher|principal|pta|homework|report card|parent.teacher|early dismissal|picture day/i],
];

export function classifyPaperwork(text: string): PaperworkKind {
  for (const [kind, rx] of KIND_SIGNALS) {
    if (rx.test(text)) return kind;
  }
  return 'other';
}

// ── Date extraction ──────────────────────────────────────────────────────────
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTH_RX = MONTHS.map((m) => m.slice(0, 3)).join('|');

function pad(n: number): string { return String(n).padStart(2, '0'); }
function toYmd(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }

/**
 * Pull explicit dates out of prose: "March 5", "Mar 5, 2026", "3/5", "3/5/26".
 * Years are inferred forward: a month/day already past this year rolls to next.
 */
export function extractDates(text: string, now: Date = new Date()): string[] {
  const out = new Set<string>();
  const year = now.getUTCFullYear();

  // "March 5" / "Mar 5, 2026"
  const nameRx = new RegExp(`\\b(${MONTH_RX})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'gi');
  for (const m of text.matchAll(nameRx)) {
    const mi = MONTHS.findIndex((mm) => mm.startsWith(m[1].toLowerCase())) + 1;
    const day = parseInt(m[2], 10);
    if (mi < 1 || day < 1 || day > 31) continue;
    let y = m[3] ? parseInt(m[3], 10) : year;
    if (!m[3] && new Date(Date.UTC(y, mi - 1, day)) < startOfDayUTC(now)) y += 1;
    out.add(toYmd(y, mi, day));
  }

  // "3/5" / "3/5/26" / "3/5/2026"
  const numRx = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  for (const m of text.matchAll(numRx)) {
    const mi = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (mi < 1 || mi > 12 || day < 1 || day > 31) continue;
    let y = m[3] ? parseInt(m[3], 10) : year;
    if (y < 100) y += 2000;
    if (!m[3] && new Date(Date.UTC(y, mi - 1, day)) < startOfDayUTC(now)) y += 1;
    out.add(toYmd(y, mi, day));
  }

  return [...out].sort();
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Amount extraction ────────────────────────────────────────────────────────
/** Largest dollar amount in the text (fees are what parents must plan for). */
export function extractAmount(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(/\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/g)) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isFinite(v) && (max === null || v > max)) max = v;
  }
  return max;
}

// ── Action extraction ────────────────────────────────────────────────────────
const ACTION_SIGNALS: [PaperworkActionKind, RegExp, string][] = [
  ['sign',     /sign(ature| and return|ed)?|consent/i,                'Sign and return'],
  ['pay',      /pay(ment)?|amount due|fee|invoice|balance|tuition/i,  'Make the payment'],
  ['rsvp',     /rsvp|reply by|respond by|confirm attendance/i,        'RSVP'],
  ['schedule', /schedule|appointment|pick.?up|drop.?off|attend|join us|open house/i, 'Put it on the calendar'],
  ['provide',  /bring|provide|send in|pack|supply|donate/i,           'Send in what’s needed'],
];

export function extractActions(text: string, now: Date = new Date()): PaperworkAction[] {
  const dates = extractDates(text, now);
  const dueOn = dates[0] ?? null;
  const amount = extractAmount(text);

  const actions: PaperworkAction[] = [];
  for (const [kind, rx, label] of ACTION_SIGNALS) {
    if (!rx.test(text)) continue;
    actions.push({
      kind,
      label,
      due_on: dueOn,
      amount: kind === 'pay' ? amount : null,
    });
  }
  if (actions.length === 0) {
    actions.push({ kind: 'review', label: 'Review it', due_on: dueOn, amount: null });
  }
  return actions;
}

// ── Urgency ──────────────────────────────────────────────────────────────────
export function urgencyOf(dueOn: string | null, now: Date = new Date()): Urgency {
  if (!dueOn) return 'normal';
  const due = new Date(`${dueOn}T00:00:00Z`);
  const days = Math.round((due.getTime() - startOfDayUTC(now).getTime()) / 86_400_000);
  if (days <= 2) return 'urgent';
  if (days <= 7) return 'soon';
  return 'normal';
}

// ── Full triage ──────────────────────────────────────────────────────────────
const KIND_LABEL: Record<PaperworkKind, string> = {
  permission_slip: 'Permission slip',
  school_notice: 'School notice',
  medical_form: 'Medical form',
  sports: 'Sports',
  bill_or_payment: 'Bill / payment',
  event_flyer: 'Event flyer',
  receipt: 'Receipt',
  reservation: 'Reservation',
  other: 'Paperwork',
};

export function kindLabel(kind: PaperworkKind): string {
  return KIND_LABEL[kind] ?? 'Paperwork';
}

/** Best-effort short title: the first non-empty line, cleaned + capped. */
export function deriveTitle(text: string, fallback = 'Untitled paperwork'): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  if (!line) return fallback;
  return line.replace(/\s+/g, ' ').slice(0, 90);
}

export function triagePaperwork(text: string, now: Date = new Date()): TriageResult {
  const kind = classifyPaperwork(text);
  const actions = extractActions(text, now);
  const dueOn = actions.map((a) => a.due_on).find((d) => d) ?? null;
  const amount = extractAmount(text);
  const urgency = urgencyOf(dueOn, now);

  // The stored RECORD, in the source language — see RECORD_LOCALE. Nothing a
  // person reads prints this string: the two screens that show a summary (the
  // Paperwork Inbox card and the household inbox queue) and the calendar event
  // "Add to calendar" writes (app/(app)/dashboard/paperwork/actions.ts) all
  // re-render it from the row with `paperworkSummary(paperworkSummaryFacts(row),
  // reader)`. Only the reply drafter's model prompt still reads it as stored.
  const parts: string[] = [kindLabel(kind)];
  if (actions.length) parts.push(actions.map((a) => a.label.toLowerCase()).slice(0, 2).join(' + '));
  if (dueOn) parts.push(`due ${dueOn}`);
  if (amount != null) parts.push(formatPaperworkAmount(amount, RECORD_LOCALE));

  return {
    kind,
    title: deriveTitle(text),
    summary: parts.join(' · '),
    due_on: dueOn,
    amount,
    actions,
    urgency,
  };
}

// ── Money, and the summary as a READER sees it ──────────────────────────────
//
// I18N-003. The summary used to carry `$${amount}`: the dollar sign was TEXT and
// `toFixed` has no locale, so a German reader got "$2768.40" where they write
// "2.768,40 $". Localising that one number would not have been enough, because
// it sat inside an English list ("Permission slip · sign and return · due …"),
// so the whole line is rendered for the reader here, word and number alike.

/**
 * The currency of an extracted amount. `extractAmount` reads only figures the
 * paper printed with a "$", and `paperwork_items` has no currency column, so
 * the dollar on the page is the only currency there is to follow. The currency
 * belongs to the MONEY; the reader's locale decides only how it is written.
 */
const PAPERWORK_CURRENCY = 'USD';

/**
 * The language the stored `summary` RECORD is written in — explicitly en-US,
 * and not the locale of whoever happened to paste the paperwork.
 *
 * A row is written once and read by every member of the family. Two of its five
 * writers are webhooks with nobody behind them (an inbound email's attachments,
 * the Contact Center), and the other three (the paste action, the capture and
 * link routes) are one member filing for everyone. There is no per-member or
 * per-family locale column to look up either (I18N-001). So the record is kept
 * in the source language, the same rule this audit applies to activity-ledger
 * rows, and each screen that shows it re-renders it in its OWN reader's locale
 * through `paperworkSummary` below.
 */
const RECORD_LOCALE: LocaleCode = 'en-US';

/** An extracted dollar amount, written the way `locale` writes money. */
export function formatPaperworkAmount(amount: number, locale: LocaleCode): string {
  return formatCents(Math.round(amount * 100), PAPERWORK_CURRENCY, locale);
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Who is reading: their locale for the numbers, their catalogue for the words. */
export type PaperworkReader = { locale: LocaleCode; t: Translate };

const KIND_KEY: Record<PaperworkKind, string> = {
  permission_slip: 'paperworkTriage.kindPermissionSlip',
  school_notice: 'paperworkTriage.kindSchoolNotice',
  medical_form: 'paperworkTriage.kindMedicalForm',
  sports: 'paperworkTriage.kindSports',
  bill_or_payment: 'paperworkTriage.kindBillOrPayment',
  event_flyer: 'paperworkTriage.kindEventFlyer',
  receipt: 'paperworkTriage.kindReceipt',
  reservation: 'paperworkTriage.kindReservation',
  other: 'paperworkTriage.kindOther',
};

/** An action on its own line: "Sign and return". */
const ACTION_KEY: Record<PaperworkActionKind, string> = {
  sign: 'paperworkTriage.actionSign',
  pay: 'paperworkTriage.actionPay',
  rsvp: 'paperworkTriage.actionRsvp',
  schedule: 'paperworkTriage.actionSchedule',
  provide: 'paperworkTriage.actionProvide',
  review: 'paperworkTriage.actionReview',
};

/** The same action mid-summary: "… · sign and return + make the payment · …". */
const SUMMARY_ACTION_KEY: Record<PaperworkActionKind, string> = {
  sign: 'paperworkTriage.summarySign',
  pay: 'paperworkTriage.summaryPay',
  rsvp: 'paperworkTriage.summaryRsvp',
  schedule: 'paperworkTriage.summarySchedule',
  provide: 'paperworkTriage.summaryProvide',
  review: 'paperworkTriage.summaryReview',
};

const has = <K extends string>(map: Record<K, string>, value: unknown): value is K =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(map, value);

/**
 * A kind's name in the reader's catalogue. Takes the stored column as it comes
 * (a plain string); a value this build does not know reads as "Paperwork", the
 * same fallback `kindLabel` gives.
 */
export function paperworkKindLabel(kind: string, reader: PaperworkReader): string {
  return reader.t(has(KIND_KEY, kind) ? KIND_KEY[kind] : KIND_KEY.other);
}

/**
 * An action's name in the reader's catalogue. A stored action whose kind this
 * build does not know keeps the label it was stored with rather than being
 * renamed to something it is not.
 */
export function paperworkActionLabel(
  action: Pick<PaperworkAction, 'kind' | 'label'>,
  reader: PaperworkReader,
): string {
  return has(ACTION_KEY, action.kind) ? reader.t(ACTION_KEY[action.kind]) : action.label;
}

/** Everything a summary is made of — each one a column the row already stores. */
export type PaperworkSummaryFacts = {
  kind: PaperworkKind;
  actions: readonly { kind: PaperworkActionKind }[];
  due_on: string | null;
  amount: number | null;
};

/**
 * Read the summary's facts back off a stored `paperwork_items` row.
 *
 * The FINER kind triage saw lives in `meta.triage_kind` (the column's CHECK
 * admits only seven, so a receipt is stored as a payment); it is preferred so
 * the reader's line names what the writer's line named.
 */
export function paperworkSummaryFacts(row: {
  kind: string;
  meta: unknown;
  actions: unknown;
  due_on: string | null;
  amount: number | null;
}): PaperworkSummaryFacts {
  const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
    ? (row.meta as Record<string, unknown>)
    : {};
  const kind: PaperworkKind = has(KIND_KEY, meta.triage_kind) ? meta.triage_kind
    : has(KIND_KEY, row.kind) ? row.kind
    : 'other';
  const actions = Array.isArray(row.actions)
    ? row.actions.flatMap((a: unknown) => {
      const actionKind = a && typeof a === 'object' ? (a as { kind?: unknown }).kind : undefined;
      return has(ACTION_KEY, actionKind) ? [{ kind: actionKind }] : [];
    })
    : [];
  return { kind, actions, due_on: row.due_on, amount: row.amount };
}

/**
 * The one-line gist, in the READER's language with the money in the reader's
 * format: a German reader gets "… · 2.768,40 $", an American one "… · $2,768.40".
 * The locale is required — a default here is how a parameter nobody passes
 * happens.
 */
export function paperworkSummary(facts: PaperworkSummaryFacts, reader: PaperworkReader): string {
  const { t, locale } = reader;
  const parts: string[] = [paperworkKindLabel(facts.kind, reader)];
  if (facts.actions.length) {
    parts.push(facts.actions.slice(0, 2).map((a) => t(SUMMARY_ACTION_KEY[a.kind])).join(' + '));
  }
  if (facts.due_on) parts.push(t('paperworkTriage.due', { date: facts.due_on }));
  if (facts.amount != null) parts.push(formatPaperworkAmount(facts.amount, locale));
  return parts.join(' · ');
}

/**
 * One extracted action as its own line: "Make the payment · 12 $ · by 2026-03-03".
 * A stored action whose kind this build does not know keeps the label it was
 * stored with rather than being renamed to something it is not.
 */
export function paperworkActionLine(
  action: Pick<PaperworkAction, 'kind' | 'label' | 'amount' | 'due_on'>,
  reader: PaperworkReader,
): string {
  const { t, locale } = reader;
  const parts: string[] = [paperworkActionLabel(action, reader)];
  if (action.amount != null) parts.push(formatPaperworkAmount(action.amount, locale));
  if (action.due_on) parts.push(t('paperworkTriage.by', { date: action.due_on }));
  return parts.join(' · ');
}
