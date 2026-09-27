// A German parent reads what the car and the house cost in their own format.
//
// finalaudit AQ-01 / I18N-003, the home-and-auto group. Six money values wrote
// the currency symbol as TEXT — `$${Number(p.premium).toLocaleString()}`,
// `$${v.toFixed(2)}` — so every reader got the American symbol position, and
// `toFixed` got nobody's grouping at all: a German parent read "$2768.50" where
// they write "2.768,50 $". Four of them are on screens a family opens (the car
// insurance card, the car and house service logs); two are inside the "Needs
// you" titles, where the amount sits in an English SENTENCE ("Card purchase to
// approve · $25"), so the words moved to the catalogue with the amount as a
// placeholder, and the title is worded for a reader the caller must name.
//
// Every case renders or calls the REAL code as a de-DE reader and asserts what
// they would see, then makes the same call as an en-US reader and asserts the
// American format still reads the way it did. None of these tables carries a
// currency column, so the currency is USD in both — only the FORMAT follows
// the reader, which is exactly the part that was hand-written.
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The service logs import their server actions; nothing here submits a form.
vi.mock('@/app/(app)/dashboard/auto/actions', () => ({
  savePolicyAction: vi.fn(), deletePolicyAction: vi.fn(),
  saveAutoServiceAction: vi.fn(), deleteAutoServiceAction: vi.fn(),
}));
vi.mock('@/app/(app)/dashboard/home/actions', () => ({
  saveServiceRecordAction: vi.fn(), deleteServiceRecordAction: vi.fn(),
}));

import { PolicyDetails } from '@/components/auto/insurance-client';
import { AutoServiceClient } from '@/components/auto/service-client';
import { ServiceClient } from '@/components/home/service-client';
import type { Tables } from '@/lib/database.types';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';
import type { NeedsReader } from '@/lib/home/needs-sources';
import { getMessages, translate, type Messages } from '@/lib/i18n/messages';
import { renderTranslated } from './helpers/render-translated';

type Reader = 'de-DE' | 'en-US';

// The reader's REAL shipped catalogue, with no stand-in words layered over it.
//
// The sentences this change moved into the catalogue (needsSources.*,
// insuranceClient.premium{Monthly,SixMonth,Annual,PerPeriod},
// serviceClient.totalLoggedAmount) arrive with the orchestrated merge of this
// group's i18n asks: English into en-US first, then the translations into de-DE.
// UNTIL THAT MERGE LANDS THIS FILE IS RED, ON PURPOSE. translate() prints a
// missing key as the key itself, and the cases below refuse exactly that: a raw
// key in front of any reader, an English sentence in front of a German one, and
// an American title that is not the English catalogue's sentence. A stand-in
// catalogue here would pass while Home showed "needsSources.toApproveWithAmount".
const messagesFor = (code: Reader): Messages => getMessages(code);
const readerFor = (code: Reader): NeedsReader => ({
  locale: code,
  t: (key, params) => translate(messagesFor(code), key, params),
});

/** Render a client component the way the app mounts it: under the reader's provider, with that reader's real catalogue. */
const renderAs = (code: Reader, node: ReactNode): string => renderTranslated(node, code);

/** Intl separates "2.768,50" from "$" with a no-break space; a reader sees a space. */
const seen = (text: string) => text.replace(/[  ]/g, ' ');

const NOW = new Date('2026-09-07T12:00:00Z');
const STAMPS = { created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-01T09:00:00Z' };

function needsFor(code: Reader, extra: Partial<HomeNeedsInput>): HomeNeedsInput {
  return {
    approvals: [], renewals: [], documents: [], conflicts: [],
    pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
    pendingChores: 0, lowGrocery: false, openTodos: 0, now: NOW,
    reader: readerFor(code),
    ...extra,
  };
}

describe('the "Needs you" titles that carry money', () => {
  const approval = { id: 'pa-1', kind: 'card_spend', amount_cents: 276_850, created_at: '2026-09-07T10:00:00Z' };

  it('writes a card purchase waiting on a German parent in their format and their words', () => {
    const [item] = buildHomeNeeds(needsFor('de-DE', { approvals: [approval] }));
    const title = seen(item.title);
    expect(title).toContain('2.768,50 $');
    expect(title).not.toMatch(/\$\s?2[.,]?768/);
    expect(title).not.toContain('to approve');
    expect(title, 'a catalogue key printed as the title').not.toContain('needsSources.');
  });

  it('still reads "$2,768.50" to an American parent', () => {
    const [item] = buildHomeNeeds(needsFor('en-US', { approvals: [approval] }));
    expect(item.title).toBe('Card purchase to approve · $2,768.50');
  });

  const paperwork = {
    id: 'pw-1', title: 'Klassenfahrt', status: 'needs_action', urgency: 'soon', due_on: '2026-09-11', created_at: '2026-09-05T08:00:00Z',
    actions: [{ kind: 'pay', label: 'Zahlung leisten', due_on: null, amount: 2768, materialized_id: null }],
  };

  it('writes a paperwork payment and its due date for a German parent', () => {
    const [item] = buildHomeNeeds(needsFor('de-DE', { paperwork: [paperwork] }));
    const title = seen(item.title);
    expect(title).toContain('2.768 $');
    expect(title).not.toContain('$2768');
    expect(title).not.toContain('due in');
    expect(title, 'a catalogue key printed as the title').not.toContain('needsSources.');
  });

  it('still reads "$2,768" and "due in 3d" to an American parent', () => {
    const [item] = buildHomeNeeds(needsFor('en-US', { paperwork: [paperwork] }));
    expect(item.title).toBe('Zahlung leisten — Klassenfahrt · $2,768 · due in 3d');
  });
});

describe('the car insurance card', () => {
  const policy: Tables<'auto_insurance_policies'> = {
    id: 'pol-1', family_id: 'fam-1', vehicle_id: null, provider: 'HUK', policy_number: 'A-1', naic: null,
    coverage_summary: null, liability_limits: null, deductible_collision: 500, deductible_comprehensive: 1250,
    agent_name: null, agent_phone: null, claims_phone: null, roadside_phone: null, effective_on: null, expires_on: null,
    premium: 1384.5, premium_period: '6_month', document_id: null, is_active: true, status: 'active', notes: null,
    created_by: null, updated_by: null, deleted_at: null, metadata: {}, ...STAMPS,
  };

  it('shows a German parent the premium and both deductibles in their format', () => {
    const html = seen(renderAs('de-DE', createElement(PolicyDetails, { policy })));
    expect(html).toContain('1.384,50 $');
    expect(html).toContain('>500 $<');
    expect(html).toContain('1.250 $');
    expect(html).not.toMatch(/\$\s?1[.,]?384/);
    expect(html).not.toContain('$500');
    expect(html, 'the raw billing period').not.toContain('6_month');
    expect(html, 'the English billing period').not.toContain('6 months');
    expect(html, 'a catalogue key printed as the premium').not.toContain('insuranceClient.');
  });

  it('still shows an American parent "$1,384.50", "$500" and "$1,250"', () => {
    const html = renderAs('en-US', createElement(PolicyDetails, { policy }));
    expect(html).toContain('$1,384.50 / 6 months');
    expect(html).toContain('>$500<');
    expect(html).toContain('>$1,250<');
  });
});

describe('the service logs', () => {
  const autoRecord: Tables<'auto_service_records'> = {
    id: 'as-1', family_id: 'fam-1', vehicle_id: null, title: 'Zahnriemen', service_date: '2026-08-14', provider: null,
    cost: 2768, mileage: 123_456, description: null, next_due_on: null, next_due_mileage: null,
    created_by: null, updated_by: null, deleted_at: null, metadata: {}, ...STAMPS,
  };
  const homeRecord: Tables<'home_service_records'> = {
    id: 'hs-1', family_id: 'fam-1', home_id: null, asset_id: null, contractor_id: null, title: 'Heizungswartung',
    service_date: '2026-08-14', provider: null, cost: 2768.4, description: null, next_due_on: null,
    created_by: null, updated_by: null, deleted_at: null, metadata: {}, ...STAMPS,
  };

  it('shows a German parent the car service cost and its total in their format', () => {
    const html = seen(renderAs('de-DE', createElement(AutoServiceClient, { records: [autoRecord], vehicles: [] })));
    // Once in the row, once in the "total logged" badge above the table.
    expect(html.match(/2\.768 \$/g)).toHaveLength(2);
    expect(html).not.toMatch(/\$\s?2[.,]?768/);
    expect(html, 'the English badge').not.toContain('Total logged');
    expect(html, 'a catalogue key printed as the badge').not.toContain('serviceClient.');
    // The odometer beside the cost is a number in the same row: German grouping too.
    expect(html).toContain('123.456 mi');
  });

  it('still shows an American parent "$2,768" for the car', () => {
    const html = renderAs('en-US', createElement(AutoServiceClient, { records: [autoRecord], vehicles: [] }));
    expect(html.match(/\$2,768(?![.\d])/g)).toHaveLength(2);
    expect(html).toContain('Total logged: $2,768<');
    expect(html).toContain('123,456 mi');
  });

  it('shows a German parent the house service cost and its total in their format', () => {
    const html = seen(renderAs('de-DE', createElement(ServiceClient, { records: [homeRecord], assets: [] })));
    // Once in the row, once in the "total logged spend" stat card.
    expect(html.match(/2\.768,40 \$/g)).toHaveLength(2);
    expect(html).not.toMatch(/\$\s?2[.,]?768/);
  });

  it('still shows an American parent "$2,768.40" for the house', () => {
    const html = renderAs('en-US', createElement(ServiceClient, { records: [homeRecord], assets: [] }));
    expect(html.match(/\$2,768\.40/g)).toHaveLength(2);
  });
});

describe('the catalogue the badge used to read', () => {
  // The car log's badge used to read serviceClient.totalLogged — "Total logged: $",
  // "Insgesamt erfasst: $" — with the number appended AFTER the translation: the
  // symbol was catalogue text, so every reader got the American position and a
  // translator could not move it. The badge now reads
  // serviceClient.totalLoggedAmount with the amount as a placeholder, and nothing
  // reads the old key any more (the only other *.totalLogged is
  // security.totalLogged, a count, not money). A dead key whose value IS the
  // defect must not stay in the shipped catalogues: the next audit reports it
  // and the next reviewer chases it. Units may not edit lib/i18n/messages/*.json,
  // so this is RED until the orchestrator drops the key from all seven real
  // catalogues (it sits on one line, "serviceClient.totalLogged", in each).
  // getMessages() is what a reader gets — en-US with the locale's overlay — so
  // a key left in ANY of the seven fails here.
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('%s no longer carries the dead "Total logged: $" key', (code) => {
    expect(getMessages(code), 'drop serviceClient.totalLogged from lib/i18n/messages/*.json').not.toHaveProperty('serviceClient.totalLogged');
  });
});
