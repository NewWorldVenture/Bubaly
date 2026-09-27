// AQ-01 / I18N-003, the approval-and-vacation group: what an approval COSTS.
//
// WHAT THIS CHANGE IS, stated plainly so the test is not read as more than it is.
// The approval card (§31) shows the amount a parent is being asked to authorise,
// and on the happy path it was ALREADY localised before this change: the card
// read `useLocale()` and called `formatAmount(amountCents, 'USD', locale.code)`,
// so a German parent already saw "2.768,50 $". What the card also had was
//
//   - a `$${(cents / 100).toFixed(2)}` FALLBACK for when Intl threw — the
//     literal the scanner counts, a hand-written American dollar with no locale
//     at all, written to every reader for money whose currency the card did not
//     know; and
//   - DEFAULTS of 'USD' and 'en-US' on formatAmount's parameters, the "optional
//     parameter nobody passes" (I18N-003), so any new caller could leave the
//     reader's locale out and still compile.
//
// Both are gone: formatAmount REQUIRES the currency and the reader's locale and
// delegates to the shared formatter, lib/wallet/ledger.ts formatCents, with no
// try/catch around it. A family sees NO DIFFERENCE on the happy path, by design.
// The change is that no path in the card writes the symbol as text any more.
//
// WHAT IS PINNED, and how hard each pin is.
//
//   1. The one RUNTIME assertion that fails on the old code: a currency code Intl
//      refuses is an ERROR now, not a German parent shown "$2768.50". That was
//      the only path where the fallback was reachable.
//   2. A SHAPE pin on the card's source: formatAmount has no parameter default,
//      no try/catch, no `$${` template, no toFixed, and delegates to formatCents;
//      and the I18N-003 scanner no longer lists this file. A source-reading pin is
//      acceptable HERE and would not be elsewhere, because the runtime behaviour
//      is unchanged by design — the signature tightening is type-level and the
//      fallback's removal is unobservable on the happy path — so a shape pin is
//      the only thing that can hold the fallback out once it is gone.
//   3. REGRESSION pins on what a reader SEES: the card, rendered through the real
//      LocaleProvider as the root layout renders it, for a de-DE, a fr-FR and an
//      en-US reader, must carry the amount in each one's own format with the
//      symbol where that locale puts it. These PASS on the old code too. They are
//      not proof of a behaviour change; they hold the happy path so that nobody
//      re-introduces a default or a literal by re-localising it wrongly later.
//      The expected strings come from the shared formatter with an EXPLICIT
//      locale, not from a hand-typed literal, and the first case pins that the
//      two readers really do get different strings — so the expectations cannot
//      quietly all be American.
//
// The other sites in this group, app/api/vacations/ai/route.ts:130 (the user
// message to the trip builder) and :305 (the concierge's system prompt), sit
// inside the text sent to the model and reach nothing else. They are model-read
// text, out of scope for this row by its own rule, and are left as they are; the
// ceiling test's header, tests/the-currency-symbol-is-not-a-literal.test.ts,
// records them.
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';
import { findHandWrittenCurrency } from '../scripts/audit-hand-written-currency.mjs';

// ── Browser and session boundaries the card reaches for ──────────────────────
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({
  decideApproval: async () => ({ ok: true, data: { status: 'approved', executed: true, resumedRunId: null, summary: 'done' } }),
  editAndApproveApproval: async () => ({ ok: true, data: { status: 'modified', resumedRunId: null } }),
}));

const { ApprovalCard, formatAmount } = await import('@/components/approvals/approval-card');
const { ToastProvider } = await import('@/components/ui/toast');
const { toApprovalCardData } = await import('@/lib/approvals/card-data');
const { PendingApprovals } = await import('@/components/home/pending-approvals');

// A request with a cost that has cents, so the fraction digits show. 2,768.50:
// large enough to group, so the grouping mark is under test as well as the
// decimal mark and the symbol's side.
const CENTS = 276850;
// And one without cents, which the formatter shows whole.
const WHOLE_CENTS = 276800;

const row = {
  id: 'appr-1', domain: 'money', capability: 'automate', requested_by_kind: 'ai', requested_by_member_id: null,
  agent: 'concierge', title: 'Book the summer cabin', summary: 'A week at the lake in July.',
  payload: { name: 'trips.book', args: { title: 'Lake cabin', nights: 7 } },
  payload_kind: 'tool', amount_cents: CENTS, confidence: 0.9,
  reasoning: 'above the family spend threshold', required_approvals: 1, approvals: [],
  status: 'pending', priority: 'normal', created_at: '2026-09-05T10:00:00Z',
  expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  run_id: 'run-1', plan_step_id: null, plan_step_ids: [],
  consequences: ['Charges the family card', 'Adds the trip to the calendar'],
  edited_payload: null,
};

/** The card as the product mounts it: under the reader's LocaleProvider. */
function render(locale: LocaleCode, node: ReactElement): string {
  // Annotated, not cast: the provider's props are checked, children included.
  const props: Parameters<typeof LocaleProvider>[0] = {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
    children: createElement(ToastProvider, null, node),
  };
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}

/** `text` as the markup carries it, so a non-breaking space or an escaped character compares equal. */
function escaped(text: string): string {
  return renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');
}

// Expected money is what the shared formatter produces for an EXPLICIT locale in
// the approval's currency, USD — the money's currency, since approval_requests
// has no currency column and a German parent authorising dollars is authorising
// dollars.
const money = (locale: LocaleCode, cents: number) => formatCents(cents, 'USD', locale);

describe('what an approval costs, in the reader\'s own format', () => {
  it('a German reader and an American reader are not shown the same string for the same cents', () => {
    // The de-DE spelling: German separators, and the symbol AFTER the amount
    // behind a non-breaking space. The en-US spelling: the symbol leads.
    expect(money('de-DE', CENTS)).toBe('2.768,50 $');
    expect(money('en-US', CENTS)).toBe('$2,768.50');
    expect(money('de-DE', CENTS)).not.toBe(money('en-US', CENTS));
  });

  it('a German parent reads the cost with German separators and the symbol where German puts it', () => {
    const data = toApprovalCardData(row, { requestedBy: null, canEdit: true });
    const html = render('de-DE', createElement(ApprovalCard, { approval: data, canDecide: true }));

    expect(html).toContain(escaped(money('de-DE', CENTS)));
    expect(html).toContain('2.768,50');
    // Not the hand-written dollar in any of its forms, and not the American
    // spelling either.
    expect(html).not.toContain('$2768');
    expect(html).not.toContain('2768.50');
    expect(html).not.toContain('$2,768.50');
    // The money stays dollars: the reader's format, the approval's currency.
    expect(html).not.toContain('€');
  });

  it('shows a German parent a whole amount whole, still in their own format', () => {
    const data = toApprovalCardData({ ...row, amount_cents: WHOLE_CENTS }, { requestedBy: null, canEdit: true });
    const html = render('de-DE', createElement(ApprovalCard, { approval: data, canDecide: true }));

    expect(html).toContain(escaped(money('de-DE', WHOLE_CENTS)));
    expect(html).toContain('2.768 $');
    expect(html).not.toContain('$2768');
    expect(html).not.toContain('$2,768');
  });

  it('a French parent reads it the French way', () => {
    const data = toApprovalCardData(row, { requestedBy: null, canEdit: true });
    const html = render('fr-FR', createElement(ApprovalCard, { approval: data, canDecide: true }));

    expect(html).toContain(escaped(money('fr-FR', CENTS)));
    // French: a comma for the decimal mark, and the symbol trailing.
    expect(html).toMatch(/768,50/);
    expect(html).not.toContain('$2768');
    expect(html).not.toContain('$2,768.50');
  });

  it('an American parent still reads "$2,768.50"', () => {
    const data = toApprovalCardData(row, { requestedBy: null, canEdit: true });
    const html = render('en-US', createElement(ApprovalCard, { approval: data, canDecide: true }));

    expect(html).toContain(escaped(money('en-US', CENTS)));
    expect(html).toContain('$2,768.50');
    expect(html).not.toContain('2.768,50');
    expect(html).not.toContain('$2768.50');
  });

  it('the compact card on Home follows the same reader', () => {
    // The Home page hands the compact card whatever it selected; when that
    // includes an amount, it renders through the same formatter.
    const de = render('de-DE', createElement(PendingApprovals, {
      items: [{ id: 'p1', title: 'Book the summer cabin', agent: 'concierge', amountCents: CENTS }],
      totalCount: 1,
      canDecide: true,
    }));
    expect(de).toContain(escaped(money('de-DE', CENTS)));
    expect(de).not.toContain('$2768');
    expect(de).not.toContain('$2,768.50');

    const en = render('en-US', createElement(PendingApprovals, {
      items: [{ id: 'p1', title: 'Book the summer cabin', agent: 'concierge', amountCents: CENTS }],
      totalCount: 1,
      canDecide: true,
    }));
    expect(en).toContain('$2,768.50');
  });

  it('a currency code Intl cannot format is an error, not a silent American dollar', () => {
    // This is the one path where the old fallback was reachable: Intl threw on
    // a malformed code and the card wrote `$${(cents / 100).toFixed(2)}` — an
    // American dollar, to every reader, for money whose currency it did not
    // know. That is not a value a German parent should ever be shown as what
    // they are authorising, so it is refused rather than guessed.
    expect(() => formatAmount(CENTS, 'not-a-code', 'de-DE')).toThrow(RangeError);
    // A well-formed code Intl does not know is still formatted, in the
    // reader's own format, with the code standing in for a symbol.
    expect(formatAmount(CENTS, 'XYZ', 'de-DE')).toBe('2.768,50 XYZ');
    expect(formatAmount(null, 'USD', 'de-DE')).toBeNull();
  });
});

// The shape pin (header, pin 2). The runtime behaviour on the happy path is the
// same before and after this change BY DESIGN, so the render cases above cannot
// tell the old formatter from the new one. What changed is the SOURCE: the
// fallback that wrote "$" as text, and the defaults that let a caller omit the
// reader's locale, are gone. Only a reading of the source can hold them out, so
// that is what this does — and it does so with the same instrument the I18N-003
// ceiling test counts with, so a fallback that came back would fail here first.
describe('the card no longer has a path that writes the symbol as text', () => {
  const CARD = 'components/approvals/approval-card.tsx';
  /** Comments out, the way scripts/audit-hand-written-currency.mjs strips them — the doc comment quotes the OLD fallback on purpose. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const source = strip(readFileSync(CARD, 'utf8'));

  it('formatAmount requires both parameters, has no fallback, and delegates to the shared formatter', () => {
    const fn = /export function formatAmount\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    expect(fn, 'formatAmount is still exported from the card').not.toBeNull();
    const [, params, body] = fn!;
    // No `= 'USD'` and no `= 'en-US'`: a caller with no reader is a type error,
    // not an American by default (I18N-003).
    expect(params, `formatAmount has a parameter default again: (${params.replace(/\s+/g, ' ').trim()})`).not.toMatch(/=/);
    expect(params).toMatch(/currency: string/);
    expect(params).toMatch(/locale: LocaleCode/);
    // No try/catch, so no path exists on which Intl's answer is replaced by a
    // hand-written one.
    expect(body, 'formatAmount has a try/catch again — the fallback was the literal').not.toMatch(/\btry\b|\bcatch\b/);
    expect(body).not.toContain('`$${');
    expect(body).not.toContain('toFixed');
    expect(body).toContain('formatCents(');
  });

  it('writes no currency symbol as text anywhere in the card', () => {
    // The whole file, not just the formatter: a `$${amount}` in the markup would
    // be the same defect in a different place.
    expect(source).not.toContain('$${');
    expect(source).not.toMatch(/['"`]\$['"`]\s*\+/);
  });

  it('is no longer a site the I18N-003 scanner counts', () => {
    // The ceiling in tests/the-currency-symbol-is-not-a-literal.test.ts is a
    // total; this names the one file this unit is responsible for, so a
    // regression here is attributed here rather than absorbed by another
    // unit's conversion lowering the total.
    const files = new Set((findHandWrittenCurrency() as { file: string; line: number }[]).map((f) => f.file));
    expect(files, `${CARD} writes a currency symbol by hand again`).not.toContain(CARD);
  });
});
