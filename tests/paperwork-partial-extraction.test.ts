import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperworkModule } from '@/components/modules/paperwork-module';
import { draftPaperworkReplyAction, materializePaperworkActionAction, setPaperworkStatusAction } from '@/app/(app)/dashboard/paperwork/actions';
import { getMessages } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { Tables } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown, locale: 'en-US' as LocaleCode }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'parent-1' }, active: { familyId: 'family-1', member: { id: 'member-1' }, family: { timezone: 'UTC' }, role: 'parent' } }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => getMessages(state.locale)[key] ?? key }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => getMessages(state.locale)[key] ?? key }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/ai/provider')>(), isAIConfigured: vi.fn(async () => false) }));

let db: ReturnType<typeof createInMemorySupabase>;
const action = { kind: 'rsvp', label: 'Confirm attendance', due_on: '2026-10-15', amount: null, materialized_as: null, materialized_id: null };
function item(partial = true): Tables<'paperwork_items'> {
  return {
    id: 'paper-1', family_id: 'family-1', title: 'School letter', kind: 'school_notice', status: 'needs_action', urgency: 'normal',
    summary: 'Derived summary', raw_text: 'Captured excerpt <script>alert(1)</script>', due_on: '2026-10-15', amount: null, sender: 'school@example.com',
    actions: [action], meta: { extraction: { method: 'multimodal', truncated: partial } },
    created_by: null, created_at: '2026-09-09T12:00:00Z', updated_at: '2026-09-09T12:00:00Z',
  };
}
beforeEach(() => {
  state.locale = 'en-US';
  db = createInMemorySupabase();
  state.db = db;
});

describe('partial paperwork stays visibly reviewable', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('renders the warning and captured excerpt in %s without generated quick actions', (locale) => {
    state.locale = locale;
    const html = renderToStaticMarkup(React.createElement(PaperworkModule, { items: [item()] }));
    const messages = getMessages(locale);
    expect(html).toContain(messages['paperwork.partialExtractionWarning']);
    expect(html).toContain(messages['paperwork.viewCapturedExcerpt']);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Add to calendar');
    expect(html).not.toContain('Draft reply with AI');
    expect(html).not.toContain('Derived summary');
    expect(html).toContain(messages['paperwork.markDone']);
  });

  it('retains normal actions for a complete document', () => {
    const html = renderToStaticMarkup(React.createElement(PaperworkModule, { items: [item(false)] }));
    expect(html).toContain('Add to calendar');
    expect(html).toContain('Draft reply with AI');
    expect(html).not.toContain(getMessages('en-US')['paperwork.partialExtractionWarning']);
  });

  it('refuses direct materialization and AI drafting from an incomplete excerpt without creating work', async () => {
    db.seed('paperwork_items', [item()]);
    const warning = getMessages('en-US')['paperwork.partialExtractionWarning'];
    await expect(materializePaperworkActionAction({ itemId: 'paper-1', actionIndex: 0 })).rejects.toThrow(warning);
    expect(await draftPaperworkReplyAction('paper-1')).toEqual({ ok: false, error: warning });
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('family_reminders')).toHaveLength(0);
    expect(db.table('paperwork_items')[0].status).toBe('needs_action');
    expect(db.table('paperwork_items')[0].actions).toEqual([action]);
  });

  it('lets a person mark the item done after checking the original', async () => {
    db.seed('paperwork_items', [item()]);
    await setPaperworkStatusAction({ itemId: 'paper-1', status: 'done' });
    expect(db.table('paperwork_items')[0].status).toBe('done');
    expect(db.table('paperwork_items')[0].meta).toMatchObject({ extraction: { truncated: true } });
  });
});
