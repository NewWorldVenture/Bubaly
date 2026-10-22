import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { change, click, nodes, render, text } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';

// The upload form's "Member" list is whose document this is. It offered every
// member the household ever had: a removed member (is_active = false, the
// nanny who left, the ex-partner) was still there to file a passport under,
// beside the people who live there. The module already keeps `activeMembers`
// for the avatars on the same screen; the list now uses it too. A document
// already filed under a removed member keeps its name in the list of files.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { DocumentsModule } = await import('@/components/modules/documents-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  h.app.members = [
    { id: 'member-1', user_id: 'user-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: 'member-2', user_id: null, display_name: 'Theo', role: 'child', is_active: true, color: null, birthday: null },
    { id: 'member-3', user_id: 'user-3', display_name: 'Former Nanny', role: 'guest', is_active: false, color: null, birthday: null },
  ];
  h.rows = {
    documents: [{
      id: 'doc-1', family_id: FAMILY, title: 'Nanny contract.pdf', category: 'general', member_id: 'member-3', is_secure: false,
      is_favorite: false, size_bytes: 1000, mime_type: 'application/pdf', storage_path: `${FAMILY}/general/1-contract.pdf`,
      created_by: 'user-1', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', expires_at: null,
    }],
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function memberOptions() {
  const element = () => createElement(DocumentsModule);
  let tree = render(h.hooks, element());
  const camera = nodes(tree).find((node) => node.type === 'input' && node.props.capture === 'environment')!;
  change(camera, [new File(['scan'], 'passport.pdf', { type: 'application/pdf' })]);
  tree = render(h.hooks, element());
  const select = nodes(tree).find((node) => node.type === 'select' && nodes(node.props.children as ReactNode).some((option) => option.props.value === ''))!;
  expect(select, 'the upload form has no member list').toBeDefined();
  return { tree, select, options: nodes(select.props.children as ReactNode).filter((node) => node.type === 'option').map((option) => text(option)) };
}

describe('the Documents upload form offers only the people in the household', () => {
  it('a removed member is not offered to file a document under', () => {
    const { options } = memberOptions();
    expect(options).toEqual([t('family.family'), 'Ada', 'Theo']);
  });

  it('picking a current member still files the document under them', async () => {
    const { select } = memberOptions();
    change(select, 'member-2');
    const tree = render(h.hooks, createElement(DocumentsModule));
    const uploads = nodes(tree).filter((node) => node.type === 'button' && text(node).trim() === t('documents.uploadFile'));
    await click(uploads[uploads.length - 1]);

    expect(h.toasts.error).toEqual([]);
    expect(db.table('documents').map((row) => row.member_id)).toEqual(['member-2']);
  });
});
