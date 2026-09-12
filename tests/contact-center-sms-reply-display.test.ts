import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactCenterModule } from '@/components/modules/contact-center-module';
import ContactCenterPage, { type InboxRow } from '@/app/(app)/dashboard/contact-center/page';
import type { SmsReplyStatus } from '@/lib/contact-center/sms-reply-status';

const state = vi.hoisted(() => ({ messages: {} as Record<string, string>, rows: [] as unknown[], readError: false,
  context: vi.fn(), statuses: vi.fn(), columns: '', calls: [] as string[] }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => state.messages[key] ?? key }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => state.messages[key] ?? key }));
vi.mock('@/lib/supabase/auth', () => ({ requirePlanLevel: state.context }));
vi.mock('@/lib/contact-center/sms-reply-status', () => ({ readSmsReplyStatuses: state.statuses }));
vi.mock('@/lib/contact-center/server', () => ({ getOrCreateChannelResult: async () => ({ data: null, error: null }) }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => false }));
vi.mock('@/app/(app)/dashboard/contact-center/actions', () => ({ assignEmailAction: vi.fn(), provisionNumberAction: vi.fn(), updateConciergeAction: vi.fn(), setMessageStatusAction: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => {
  state.calls.push('service');
  const query = {
    select: (columns: string) => { state.columns = columns; return query; },
    eq: (column: string, value: string) => { expect([column, value]).toEqual(['family_id', '11111111-1111-4111-8111-111111111111']); return query; },
    order: () => query, limit: () => query,
    then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.readError ? { message: 'Synthetic inbox outage' } : null }).then(resolve),
  };
  return { from: () => query };
} }));

const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const statuses: SmsReplyStatus[] = ['prepared', 'confirmation_unknown', 'suppressed', 'legacy_unknown', 'unavailable'];
const labels = ['prepared', 'confirmationUnknown', 'suppressed', 'legacyUnknown', 'unavailable'];
function messages(): InboxRow[] {
  return statuses.map((_status, i) => ({ id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, channel: 'sms', direction: 'outbound',
    from_addr: '+15555550101', to_addr: '+15555550202', subject: null, body: `Fixture reply ${i}`, ai_summary: null,
    ai_intent: null, status: 'read', occurred_at: '2026-09-12T12:00:00.000Z' }));
}
function catalogue(locale = 'en-US') { state.messages = JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')); }
function render(rows: InboxRow[], values: Record<string, SmsReplyStatus> = {}) {
  return renderToStaticMarkup(React.createElement(ContactCenterModule, { messages: rows, smsReplyStatuses: values, channel: null,
    suggestedLocal: 'ours', twilioReady: false, canManage: false }));
}
beforeEach(() => {
  vi.clearAllMocks(); catalogue(); state.rows = messages(); state.readError = false; state.calls = []; state.columns = '';
  state.context.mockImplementation(async () => { state.calls.push('authorization'); return { active: { familyId: '11111111-1111-4111-8111-111111111111', family: { name: 'Ours' }, role: 'child' } }; });
  state.statuses.mockImplementation(async (rows: InboxRow[]) => Object.fromEntries(rows.map((row, i) => [row.id, statuses[i]])));
});

describe('actual Contact Center SMS status rendering', () => {
  it.each(locales)('renders all five translated statuses and explanations in %s without retry controls', locale => {
    catalogue(locale); const rows = messages();
    const html = render(rows, Object.fromEntries(rows.map((row, i) => [row.id, statuses[i]])));
    for (const key of labels) {
      const label = state.messages[`contactSmsReply.${key}`], detail = state.messages[`contactSmsReply.${key}Detail`];
      expect(label).toBeTruthy(); expect(detail).toBeTruthy();
      expect(html).toContain(renderToStaticMarkup(React.createElement('p', { className: 'font-semibold' }, label)));
      expect(html).toContain(renderToStaticMarkup(React.createElement('p', { className: 'mt-1' }, detail)));
    }
    expect(html).not.toContain('contactSmsReply.');
    expect(html).not.toContain('<button');
  });

  it('shows unavailable when an SMS status was not verified', () => {
    const html = render([messages()[0]]);
    expect(html).toContain(state.messages['contactSmsReply.unavailable']);
    expect(html).not.toContain(state.messages['contactSmsReply.prepared']);
  });

  it.each(['email', 'voice'] as const)('leaves %s message rendering free of SMS status claims', channel => {
    const html = render([{ ...messages()[0], channel }]);
    expect(html).toContain('Fixture reply 0');
    for (const key of labels) expect(html).not.toContain(state.messages[`contactSmsReply.${key}`]);
  });

  it('passes only the displayed inbox and safe statuses through the actual server page', async () => {
    const page = await ContactCenterPage();
    expect(state.calls[0]).toBe('authorization');
    expect(state.context).toHaveBeenCalledWith(2);
    expect(state.statuses).toHaveBeenCalledWith(state.rows);
    expect(state.columns).not.toMatch(/inputs|outputs|emission|provider_ref|family_id/);
    expect(page.props.messages).toEqual(state.rows);
    expect(page.props.smsReplyStatuses).toEqual(Object.fromEntries(messages().map((row, i) => [row.id, statuses[i]])));
    expect(JSON.stringify(page.props)).not.toMatch(/emissionToken|revision|inputs|outputs|requested_by|provider_ref/);
    expect(renderToStaticMarkup(page)).toContain(state.messages['contactSmsReply.confirmationUnknown']);
  });

  it('keeps the verified inbox readable when reply status is unavailable', async () => {
    state.statuses.mockResolvedValue(Object.fromEntries(messages().map(row => [row.id, 'unavailable'])));
    const html = renderToStaticMarkup(await ContactCenterPage());
    expect(html).toContain('Fixture reply 0');
    expect(html).toContain(state.messages['contactSmsReply.unavailable']);
  });

  it('does not query private status when the underlying inbox failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.readError = true;
    const html = renderToStaticMarkup(await ContactCenterPage());
    expect(state.statuses).not.toHaveBeenCalled();
    expect(html).toContain(state.messages['contactCenter.theContactCenterIsTemporarily']);
    vi.restoreAllMocks();
  });
});
