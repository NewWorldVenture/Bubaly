import { createElement } from 'react';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performUpload, type UploadEffects } from '@/lib/documents/upload';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, change, click, form, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const transport = vi.hoisted(() => ({ client: null as unknown, refresh: vi.fn() }));
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
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);

const { FilesHubModule } = await import('@/components/modules/files-hub-module');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const request = { view: 'vault' as const, category: 'legal', manager: true, folderFallback: 'vault' };
const storedPath = 'family/legal/will.pdf';
const originalFamilyId = h.app.familyId;

beforeEach(() => {
  resetHookSlots(h.hooks);
  Object.assign(h.app, { role: 'parent', familyId: originalFamilyId });
  h.toasts = { success: [], error: [] };
  transport.refresh.mockReset();
});

type Reply = 'success' | 'lost-after-commit' | 'gateway-after-commit' | 'unknown-code-after-commit' | 'lost-before-commit' | '23514' | '42501' | 'empty-receipt' | 'mismatched-receipt' | 'upload-lost-after-commit' | 'upload-lost-before-commit' | 'read-failure' | 'held-metadata';

/** Actual SDK and upload helpers; remote commit/reply order is synthetic, not an Auth/RLS rehearsal. */
function server(initialReply: Reply) {
  let reply = initialReply;
  const objects = new Set<string>();
  const contents = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];
  const calls: { method: string; path: string }[] = [];
  const guardedAtUpload: boolean[] = [];
  let release: (() => void) | undefined;
  transport.client = createClient('https://document-outcome.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => 'synthetic-session',
    global: { fetch: async (input, init) => {
      const sent = new Request(input, init), url = new URL(sent.url);
      expect(url.origin).toBe('https://document-outcome.invalid');
      calls.push({ method: sent.method, path: url.pathname });
      if (sent.method === 'GET' && url.pathname === '/rest/v1/documents') {
        expect(url.searchParams.get('family_id')).toBe(`eq.${h.app.familyId}`);
        if (reply === 'read-failure') return Response.json({ code: '42501', message: 'Synthetic read refused' }, { status: 403 });
        const id = url.searchParams.get('id')?.slice(3);
        return Response.json(rows.filter(row => row.id === id && row.family_id === h.app.familyId));
      }
      if (sent.method === 'POST' && url.pathname.startsWith('/storage/v1/object/documents/')) {
        const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/documents/'.length));
        expect(path.startsWith(`${h.app.familyId}/`)).toBe(true);
        expect(sent.headers.get('x-upsert')).toBe('true');
        guardedAtUpload.push(rows.some(row => row.storage_path === path && row.is_secure === true && row.category === 'legal'));
        const body = await sent.formData();
        const bytes = [...body.values()].find(value => value instanceof Blob) as Blob;
        const content = await bytes.text();
        expect(['Synthetic private document', 'Xynthetic private document']).toContain(content);
        if (reply !== 'upload-lost-before-commit') { objects.add(path); contents.set(path, content); }
        if (reply === 'upload-lost-after-commit' || reply === 'upload-lost-before-commit') throw new TypeError('Failed to fetch');
        return Response.json({ Key: `documents/${path}`, Id: 'object-1' });
      }
      if (sent.method === 'POST' && url.pathname === '/rest/v1/documents') {
        const row = await sent.json();
        expect(row).toMatchObject({ family_id: h.app.familyId, created_by: h.app.userId });
        expect(sent.headers.get('prefer')).toContain('return=representation');
        if (reply === '23514' || reply === '42501') return Response.json({ code: reply, message: 'Synthetic statement refused' }, { status: 400 });
        if (reply !== 'lost-before-commit') rows.push(row);
        if (reply === 'held-metadata') await new Promise<void>(resolve => { release = resolve; });
        if (reply === 'lost-after-commit' || reply === 'lost-before-commit') throw new TypeError('Failed to fetch');
        if (reply === 'gateway-after-commit') return new Response('Gateway timeout', { status: 504 });
        if (reply === 'unknown-code-after-commit') return Response.json({ code: 'UPSTREAM_TIMEOUT', message: 'Synthetic gateway error' }, { status: 502 });
        if (reply === 'empty-receipt') return Response.json(null, { status: 201 });
        if (reply === 'mismatched-receipt') return Response.json({ ...row, is_secure: false }, { status: 201 });
        return Response.json(row, { status: 201 });
      }
      if (sent.method === 'DELETE' && url.pathname === '/storage/v1/object/documents') {
        const body = await sent.json() as { prefixes: string[] };
        return Response.json(body.prefixes.filter(path => objects.delete(path)).map(name => ({ name })));
      }
      throw new Error(`Unexpected synthetic request: ${sent.method} ${url.pathname}`);
    } },
  });
  return { objects, contents, rows, calls, guardedAtUpload, reply: (next: Reply) => { reply = next; }, release: () => release?.() };
}

function screen(view: 'vault' | 'shared' = 'vault') { return render(h.hooks, createElement(FilesHubModule, { view })); }
async function submitOpen(view: 'vault' | 'shared' = 'vault') {
  await (form(screen(view)).props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
}
async function uploadFromForm(view: 'vault' | 'shared' = 'vault', category = 'legal') {
  await click(byName(screen(view), t('filesHub.upload'), 'button'));
  const fileInput = nodes(screen(view)).find(node => node.type === 'input' && node.props.type === 'file')!;
  change(fileInput, [new File(['Synthetic private document'], 'will.pdf', { type: 'application/pdf' })]);
  const categoryInput = nodes(screen(view)).find(node => node.type === 'input' && node.props.placeholder === t('filesHub.eGTravelSchoolFinances'))!;
  change(categoryInput, category);
  await submitOpen(view);
}

const storageCalls = (state: ReturnType<typeof server>) => state.calls.filter(call => call.path.startsWith('/storage/'));

describe('Files hub reserves document protection before uploading bytes', () => {
  it.each(['lost-after-commit', 'gateway-after-commit', 'unknown-code-after-commit', 'empty-receipt', 'mismatched-receipt'] as const)('sends no bytes after an unconfirmed metadata receipt: %s', async reply => {
    const state = server(reply);
    await uploadFromForm();
    expect(state.rows).toHaveLength(1);
    expect(state.objects.size).toBe(0);
    expect(storageCalls(state)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([t('quickCapture.saveUncertain')]);
    expect(nodes(screen()).find(node => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(false);
  });

  it('leaves no unmatched private object if metadata never committed', async () => {
    const state = server('lost-before-commit');
    await uploadFromForm();
    expect(state.rows).toEqual([]);
    expect(state.objects.size).toBe(0);
    expect(storageCalls(state)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
  });

  it.each(['23514', '42501'] as const)('sends no bytes after a definite %s reservation refusal', async reply => {
    const state = server(reply);
    await uploadFromForm();
    expect(state.rows).toEqual([]);
    expect(storageCalls(state)).toEqual([]);
    expect(h.toasts.error).toEqual([t('avatarPicker.uploadFailed')]);
  });

  it.each(['upload-lost-after-commit', 'upload-lost-before-commit'] as const)('retains the protective row through %s and safely retries the same reservation', async reply => {
    const state = server(reply);
    await uploadFromForm();
    expect(state.rows).toHaveLength(1);
    expect(state.guardedAtUpload).toEqual([true]);
    expect(state.objects.size).toBe(reply === 'upload-lost-after-commit' ? 1 : 0);
    expect(h.toasts.error).toEqual([t('quickCapture.saveUncertain')]);
    const original = { ...state.rows[0] };
    state.reply('success');
    await submitOpen();
    expect(state.rows).toEqual([original]);
    expect(state.guardedAtUpload).toEqual([true, true]);
    expect(state.objects).toEqual(new Set([original.storage_path]));
    expect(state.calls.filter(call => call.method === 'DELETE')).toEqual([]);
    expect(h.toasts.success).toEqual([t('filesHubModule.fileUploaded')]);
  });

  it('reconciles a lost metadata reply without inserting a second row on retry', async () => {
    const state = server('lost-after-commit');
    await uploadFromForm();
    const original = { ...state.rows[0] };
    state.reply('success');
    await submitOpen();
    expect(state.rows).toEqual([original]);
    expect(state.calls.filter(call => call.method === 'POST' && call.path === '/rest/v1/documents')).toHaveLength(1);
    expect(state.guardedAtUpload).toEqual([true]);
    expect(state.objects).toEqual(new Set([original.storage_path]));
  });

  it('allocates a new reservation for a different File with the same name, size and type', async () => {
    const state = server('upload-lost-after-commit');
    await uploadFromForm();
    const original = { ...state.rows[0] };
    const replacement = new File(['Xynthetic private document'], 'will.pdf', { type: 'application/pdf' });
    expect(replacement.size).toBe(original.size_bytes);
    const picker = nodes(screen()).find(node => node.type === 'input' && node.props.type === 'file')!;
    change(picker, [replacement]);
    state.reply('success');
    await submitOpen();
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1].id).not.toBe(original.id);
    expect(state.rows[1].storage_path).not.toBe(original.storage_path);
    expect(state.contents.get(original.storage_path as string)).toBe('Synthetic private document');
    expect(state.contents.get(state.rows[1].storage_path as string)).toBe('Xynthetic private document');
    expect(state.objects.size).toBe(2);
  });

  it('does not upload on retry when the saved reservation no longer matches its security intent', async () => {
    const state = server('lost-after-commit');
    await uploadFromForm();
    state.rows[0].is_secure = false;
    state.reply('success');
    await submitOpen();
    expect(storageCalls(state)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
  });

  it('does not upload on retry when the protective reservation cannot be read', async () => {
    const state = server('lost-after-commit');
    await uploadFromForm();
    state.reply('read-failure');
    await submitOpen();
    expect(storageCalls(state)).toEqual([]);
    expect(state.rows).toHaveLength(1);
    expect(h.toasts.success).toEqual([]);
  });

  it.each(['/legal', 'legal//scan', '.', '..', 'legal/../scan', 'legal?scope=other', 'legal#fragment', 'legal%2fscan', 'legal\\scan'])('refuses unsafe folder %s before any metadata or bytes', async category => {
    const state = server('success');
    await uploadFromForm('vault', category);
    expect(state.calls).toEqual([]);
    expect(state.rows).toEqual([]);
    expect(state.objects.size).toBe(0);
    expect(h.toasts.error).toEqual([t('avatarPicker.uploadFailed')]);
  });

  it('preserves a valid nested folder and its exact protected object path', async () => {
    const state = server('success');
    await uploadFromForm('vault', 'legal/Family records');
    expect(state.rows).toHaveLength(1);
    expect(state.objects).toEqual(new Set([state.rows[0].storage_path]));
    expect(h.toasts.success).toEqual([t('filesHubModule.fileUploaded')]);
  });

  it.each(['family', 'draft'] as const)('a late reservation after a %s change sends no bytes and does not complete the new form', async changed => {
    const state = server('held-metadata');
    const pending = uploadFromForm();
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    if (changed === 'family') h.app.familyId = 'different-family';
    else {
      const title = nodes(screen()).find(node => node.type === 'input' && node.props.placeholder === t('documents.eGPassportEmmaPdf'))!;
      change(title, 'A new draft');
    }
    screen();
    state.release();
    await pending;
    expect(storageCalls(state)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([]);
    expect(nodes(screen()).some(node => node.type === 'form')).toBe(true);
  });

  it('preserves a healthy private upload with protection in place before bytes arrive', async () => {
    const state = server('success');
    await uploadFromForm();
    expect(state.rows).toHaveLength(1);
    expect(state.guardedAtUpload).toEqual([true]);
    expect(state.objects.has(state.rows[0].storage_path as string)).toBe(true);
    expect(h.toasts.success).toEqual([t('filesHubModule.fileUploaded')]);
    expect(h.toasts.error).toEqual([]);
    expect(transport.refresh).toHaveBeenCalledOnce();
    expect(nodes(screen()).some(node => node.type === 'form')).toBe(false);
  });

  it('retains the ordinary shared-file child control', async () => {
    Object.assign(h.app, { role: 'child' });
    const state = server('success');
    await uploadFromForm('shared', 'school');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ is_secure: false, category: 'school' });
    expect(state.objects.has(state.rows[0].storage_path as string)).toBe(true);
    expect(h.toasts.success).toEqual([t('filesHubModule.fileUploaded')]);
  });
});

describe('document upload failures settle without sending unprotected bytes', () => {
  function effects(overrides: Partial<UploadEffects> = {}) {
    return {
      prepare: vi.fn(() => storedPath),
      store: vi.fn(async () => ({ error: null })),
      record: vi.fn(async () => ({ error: null })),
      ...overrides,
    };
  }

  it('sends no bytes when the metadata effect rejects after a possible commit', async () => {
    const fx = effects({ record: async () => { throw new Error('Synthetic lost response'); } });
    await expect(performUpload(request, fx, t)).resolves.toEqual({ ok: false, reason: t('quickCapture.saveUncertain') });
    expect(fx.store).not.toHaveBeenCalled();
  });

  it('sends no bytes for a metadata error message without proof of refusal', async () => {
    const fx = effects({ record: async () => ({ error: 'Upload response unavailable' }) });
    await expect(performUpload(request, fx, t)).resolves.toEqual({ ok: false, reason: 'Upload response unavailable' });
    expect(fx.store).not.toHaveBeenCalled();
  });

  it('settles a rejected storage effect while retaining the prior reservation', async () => {
    const fx = effects({ store: async () => { throw new Error('Synthetic upload transport failure'); } });
    await expect(performUpload(request, fx, t)).resolves.toEqual({ ok: false, reason: t('quickCapture.saveUncertain') });
    expect(fx.record).toHaveBeenCalledWith({ storagePath: storedPath, isSecure: true });
  });
});
