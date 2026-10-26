import { createElement } from 'react';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, change, click, form, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const transport = vi.hoisted(() => ({ client: null as unknown, refresh: vi.fn(), outbound: vi.fn() }));
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh: transport.refresh }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => transport.client }));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
const { FilesHubModule } = await import('@/components/modules/files-hub-module');
const { DocumentsModule } = await import('@/components/modules/documents-module');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
type Surface = 'files' | 'documents';
type Mode = 'success' | 'metadata-lost-after' | 'metadata-lost-before' | 'metadata-empty' | 'metadata-mismatch' | 'metadata-refused' | 'read-refused' | 'duplicate-match' | 'duplicate-mismatch' | 'storage-lost-after' | 'storage-lost-before' | 'held-metadata' | 'held-storage';
const initial = { family: h.app.familyId, user: h.app.userId };
beforeEach(() => {
  resetHookSlots(h.hooks); Object.assign(h.app, { role: 'parent', familyId: initial.family, userId: initial.user });
  h.toasts = { success: [], error: [] }; transport.refresh.mockReset();
  transport.outbound.mockReset().mockImplementation(() => { throw new Error('Unexpected external fetch'); });
  vi.stubGlobal('fetch', transport.outbound);
});
afterEach(() => { expect(transport.outbound).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Actual SDK, storage helper, coordinator and both components. Only HTTP
// commit/reply ordering is modeled; no account/Storage/RLS server is contacted.
function server(start: Mode) {
  let mode = start; let release: (() => void) | undefined;
  const family = h.app.familyId, user = h.app.userId;
  const rows: Record<string, unknown>[] = [], objects = new Set<string>();
  const calls: { method: string; path: string }[] = [], protectedAtUpload: boolean[] = [];
  transport.client = createClient('https://document-reservation.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, accessToken: async () => 'synthetic-session',
    global: { fetch: async (input, init) => {
      const sent = new Request(input, init), url = new URL(sent.url);
      expect(url.origin).toBe('https://document-reservation.invalid'); calls.push({ method: sent.method, path: url.pathname });
      if (sent.method === 'GET' && url.pathname === '/rest/v1/documents') {
        expect(url.searchParams.get('family_id')).toBe(`eq.${family}`);
        if (mode === 'read-refused') return Response.json({ code: '42501', message: 'Synthetic read refusal' }, { status: 403 });
        const id = url.searchParams.get('id')?.slice(3);
        return Response.json(rows.filter(r => r.id === id && r.family_id === family));
      }
      if (sent.method === 'POST' && url.pathname === '/rest/v1/documents') {
        const row = await sent.json(); expect(row).toMatchObject({ family_id: family, created_by: user });
        if (mode === 'metadata-refused') return Response.json({ code: '23514', message: 'Synthetic definite refusal' }, { status: 400 });
        if (mode !== 'metadata-lost-before') rows.push(mode === 'duplicate-mismatch' ? { ...row, is_secure: !row.is_secure } : row);
        if (mode === 'held-metadata') await new Promise<void>(resolve => { release = resolve; });
        if (mode === 'metadata-lost-after' || mode === 'metadata-lost-before') throw new TypeError('Synthetic response lost');
        if (mode === 'duplicate-match' || mode === 'duplicate-mismatch') return Response.json({ code: '23505', message: 'Synthetic insert collision' }, { status: 409 });
        if (mode === 'metadata-empty') return Response.json(null, { status: 201 });
        if (mode === 'metadata-mismatch') return Response.json({ ...row, storage_path: 'different-family/wrong.pdf' }, { status: 201 });
        return Response.json(row, { status: 201 });
      }
      if (sent.method === 'POST' && url.pathname.startsWith('/storage/v1/object/documents/')) {
        const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/documents/'.length));
        expect(path.startsWith(`${family}/`)).toBe(true);
        // The released DB recognizes legal; translated-sensitive categories
        // require the real coordinator's is_secure flag, asserted separately.
        protectedAtUpload.push(rows.some(r => r.storage_path === path && (r.is_secure === true || r.category === 'legal')));
        if (mode !== 'storage-lost-before') objects.add(path);
        if (mode === 'held-storage') await new Promise<void>(resolve => { release = resolve; });
        if (mode === 'storage-lost-after' || mode === 'storage-lost-before') throw new TypeError('Synthetic storage reply lost');
        return Response.json({ Key: `documents/${path}`, Id: 'synthetic-object' });
      }
      if (sent.method === 'DELETE' && url.pathname === '/storage/v1/object/documents') {
        const body = await sent.json() as { prefixes: string[] }; return Response.json(body.prefixes.filter(p => objects.delete(p)).map(name => ({ name })));
      }
      if (sent.method === 'POST' && url.pathname === '/storage/v1/object/list/documents') return Response.json([]);
      throw new Error(`Unexpected synthetic request ${sent.method} ${url.pathname}`);
    } },
  });
  return { rows, objects, calls, protectedAtUpload, mode: (next: Mode) => { mode = next; }, release: () => release?.() };
}
function screen(surface: Surface, view: 'vault' | 'shared' = 'vault') {
  return render(h.hooks, surface === 'files' ? createElement(FilesHubModule, { view }) : createElement(DocumentsModule));
}
async function submit(surface: Surface, view: 'vault' | 'shared' = 'vault') {
  const tree = screen(surface, view);
  if (surface === 'files') await (form(tree).props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
  else {
    const buttons = nodes(tree).filter(n => n.type === 'button' && text(n).trim() === t('documents.uploadFile'));
    await click(buttons[buttons.length - 1]);
  }
}
async function open(surface: Surface, category = 'legal', view: 'vault' | 'shared' = 'vault') {
  if (surface === 'files') await click(byName(screen(surface, view), t('filesHub.upload'), 'button'));
  const tree = screen(surface, view);
  const picker = nodes(tree).find(n => n.type === 'input' && (surface === 'files' ? n.props.type === 'file' : n.props.capture === 'environment'))!;
  change(picker, [new File(['Synthetic scan'], 'scan.pdf', { type: 'application/pdf' })]);
  const folder = nodes(screen(surface, view)).find(n => n.type === 'input' && (surface === 'files' ? n.props.placeholder === t('filesHub.eGTravelSchoolFinances') : n.props.list === 'folder-options'))!;
  change(folder, category); screen(surface, view);
}
const storage = (s: ReturnType<typeof server>) => s.calls.filter(c => c.path.startsWith('/storage/'));

describe.each(['files', 'documents'] as const)('%s reserves metadata before bytes', surface => {
  it('reserves protection before bytes and retains a healthy private upload', async () => {
    const s = server('success'); await open(surface); await submit(surface);
    expect(s.protectedAtUpload).toEqual([true]); expect(s.rows).toHaveLength(1);
    expect(s.objects).toEqual(new Set([s.rows[0].storage_path])); expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toHaveLength(1); expect(transport.refresh).toHaveBeenCalledOnce();
  });
  it.each(['metadata-lost-after', 'metadata-lost-before', 'metadata-empty', 'metadata-mismatch', 'metadata-refused', 'read-refused'] as const)('sends no bytes for %s', async mode => {
    const s = server(mode); await open(surface); await submit(surface);
    expect(storage(s)).toEqual([]); expect(s.objects.size).toBe(0); expect(h.toasts.success).toEqual([]); expect(h.toasts.error).toHaveLength(1);
  });
  it.each(['storage-lost-after', 'storage-lost-before'] as const)('retains protective metadata through %s and reuses it on retry', async mode => {
    const s = server(mode); await open(surface); await submit(surface);
    expect(s.rows).toHaveLength(1); const original = { ...s.rows[0] };
    expect(s.protectedAtUpload).toEqual([true]); expect(h.toasts.success).toEqual([]);
    expect(s.objects.size).toBe(mode === 'storage-lost-after' ? 1 : 0);
    s.mode('success'); await submit(surface);
    expect(s.rows).toEqual([original]); expect(s.protectedAtUpload).toEqual([true, true]);
    expect(s.calls.filter(c => c.method === 'DELETE')).toEqual([]); expect(h.toasts.success).toHaveLength(1);
  });
  it('recovers a lost metadata reply using the same matching row', async () => {
    const s = server('metadata-lost-after'); await open(surface); await submit(surface); const original = { ...s.rows[0] };
    s.mode('success'); await submit(surface);
    expect(s.rows).toEqual([original]); expect(s.calls.filter(c => c.method === 'POST' && c.path === '/rest/v1/documents')).toHaveLength(1);
    expect(s.protectedAtUpload).toEqual([true]); expect(h.toasts.success).toHaveLength(1);
  });
  it('uses a different reservation for a new same-name same-size File', async () => {
    const s = server('storage-lost-after'); await open(surface); await submit(surface);
    const original = { ...s.rows[0] };
    const picker = nodes(screen(surface)).find(n => n.type === 'input' && (surface === 'files' ? n.props.type === 'file' : n.props.capture === 'environment'))!;
    change(picker, [new File(['Xynthetic scan'], 'scan.pdf', { type: 'application/pdf' })]); screen(surface);
    s.mode('success'); await submit(surface);
    expect(s.rows).toHaveLength(2); expect(s.rows[1].id).not.toBe(original.id);
    expect(s.rows[1].storage_path).not.toBe(original.storage_path);
    expect(s.objects).toEqual(new Set([original.storage_path, s.rows[1].storage_path]));
  });
  it('refuses a retry whose protective row has changed', async () => {
    const s = server('metadata-lost-after'); await open(surface); await submit(surface);
    s.rows[0].storage_path = 'different-family/changed.pdf'; s.mode('success'); await submit(surface);
    expect(storage(s)).toEqual([]); expect(h.toasts.success).toEqual([]);
  });
  it.each(['duplicate-match', 'duplicate-mismatch'] as const)('checks exact23505 readback for %s', async mode => {
    const s = server(mode); await open(surface); await submit(surface);
    expect(s.calls.filter(c => c.method === 'GET')).toHaveLength(2);
    expect(s.objects.size).toBe(mode === 'duplicate-match' ? 1 : 0);
    expect(h.toasts.success).toHaveLength(mode === 'duplicate-match' ? 1 : 0);
  });
  it('retains the current translated-sensitive flag in Shared', async () => {
    const s = server('success'); await open(surface, 'Financiën', 'shared'); await submit(surface, 'shared');
    expect(s.rows[0]).toMatchObject({ category: 'Financiën', is_secure: true }); expect(s.protectedAtUpload).toEqual([true]);
  });
  it('retains ordinary child uploads', async () => {
    Object.assign(h.app, { role: 'child' }); const s = server('success'); await open(surface, 'school', 'shared'); await submit(surface, 'shared');
    expect(s.rows[0]).toMatchObject({ category: 'school', is_secure: false }); expect(s.objects.size).toBe(1);
  });
  it.each(['family', 'user', 'draft'] as const)('a late metadata receipt after a %s change sends no bytes or stale success', async changed => {
    const s = server('held-metadata'); await open(surface); const pending = submit(surface);
    await vi.waitFor(() => expect(s.rows).toHaveLength(1));
    if (changed === 'family') h.app.familyId = 'different-family'; else if (changed === 'user') h.app.userId = 'different-user';
    else {
      const title = nodes(screen(surface)).find(n => n.type === 'input' && n.props.placeholder === t('documents.eGPassportEmmaPdf'));
      expect(title).toBeDefined(); change(title!, 'New draft');
    }
    screen(surface); s.release(); await pending;
    expect(storage(s)).toEqual([]); expect(h.toasts.success).toEqual([]); expect(h.toasts.error).toEqual([]);
  });
  it.each(['family', 'user', 'draft'] as const)('a late Storage reply after a %s change leaves the protected object and does not complete the new draft', async changed => {
    const s = server('held-storage'); await open(surface); const pending = submit(surface);
    await vi.waitFor(() => expect(s.objects.size).toBe(1));
    if (changed === 'family') h.app.familyId = 'different-family'; else if (changed === 'user') h.app.userId = 'different-user';
    else change(nodes(screen(surface)).find(n => n.type === 'input' && n.props.placeholder === t('documents.eGPassportEmmaPdf'))!, 'New draft');
    screen(surface); s.release(); await pending;
    expect(s.rows).toHaveLength(1); expect(s.objects.size).toBe(1); expect(s.protectedAtUpload).toEqual([true]);
    expect(s.calls.filter(c => c.method === 'DELETE')).toEqual([]); expect(h.toasts.success).toEqual([]); expect(h.toasts.error).toEqual([]);
  });
});
