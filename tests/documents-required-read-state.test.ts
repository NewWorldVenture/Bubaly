import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Real DocumentsModule/render helpers; the query's public read-state contract
// is supplied directly. Replacing the hook BEFORE import keeps Auth/cache/
// coordinator infrastructure out of this fixture entirely.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({ data: [] as Record<string, unknown>[], loading: false, stale: false, error: null as string | null, refreshes: 0 }));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error('Unexpected SDK, Storage or upload operation'); }));
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => {
  if (table !== 'documents') throw Error('Unexpected read');
  return { ...live, refresh: async () => { live.refreshes++; } };
} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: forbidden }));
vi.mock('@/lib/documents/upload', () => ({ performUpload: forbidden }));
vi.mock('@/lib/storage/documents', () => ({
  buildFamilyPath: forbidden, isReservedDocumentPath: forbidden, uploadFamilyDocument: forbidden,
  getDocumentSignedUrl: forbidden, removeFamilyDocument: forbidden, DOCUMENT_MAX_BYTES: 10_485_760, DOCUMENT_MAX_MB: 10,
}));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/states', () => ({
  SkeletonList: () => createElement('div', { role: 'status' }, 'Awaiting verified document read'),
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => createElement('div', { role: 'alert' },
    message, createElement('button', { onClick: onRetry }, 'Retry document read')),
}));
const { DocumentsModule } = await import('@/components/modules/documents-module');
const TITLE = 'synthetic-read-boundary.pdf';
const screen = () => render(h.hooks, createElement(DocumentsModule));
const hasRole = (role: string) => nodes(screen()).some(n => n.props.role === role);
beforeEach(() => {
  resetHookSlots(h.hooks); forbidden.mockClear(); live.refreshes = 0; live.loading = false; live.stale = false; live.error = null;
  Object.assign(h.app, { role: 'parent' }); h.timeZone = 'UTC';
  live.data = [{ id: 'synthetic-document', family_id: h.app.familyId, title: TITLE, category: 'general',
    storage_path: 'synthetic-family/general/synthetic.pdf', mime_type: 'application/pdf', size_bytes: 1_073_741_824,
    member_id: null, created_by: null, is_favorite: false, is_secure: false, expires_at: null,
    created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z' }];
  vi.stubGlobal('fetch', forbidden);
});
afterEach(() => { expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('document list read verification', () => {
  it('hides cached file rows, actions and capacity totals until revalidated', () => {
    live.stale = true;
    expect(hasRole('status')).toBe(true);
    expect(text(screen())).not.toContain(TITLE);
    expect(text(screen())).not.toContain('1.0 GB');
    expect(nodes(screen()).some(n => n.type === 'button')).toBe(false);
  });
  it('does not describe a stale empty cache as an empty collection or free capacity', () => {
    live.data = []; live.stale = true;
    expect(hasRole('status')).toBe(true);
    expect(text(screen())).not.toContain('No files yet');
    expect(text(screen())).not.toContain('free');
  });
  it('keeps ordinary initial loading pending', () => {
    live.loading = true; expect(hasRole('status')).toBe(true); expect(text(screen())).not.toContain(TITLE);
  });
  it('shows a failed stale read as actionable error instead of a permanent skeleton', () => {
    live.stale = true; live.error = 'Synthetic document read failed';
    expect(hasRole('alert')).toBe(true); expect(hasRole('status')).toBe(false);
    expect(text(screen())).toContain(live.error); expect(text(screen())).not.toContain(TITLE);
  });
  it('shows verified healthy rows and their measured capacity', () => {
    expect(text(screen())).toContain(TITLE); expect(text(screen())).toContain('1.0 GB');
    expect(hasRole('status')).toBe(false); expect(hasRole('alert')).toBe(false);
  });
  it('allows a verified empty collection to say no files yet', () => {
    live.data = []; expect(text(screen())).toContain('No files yet'); expect(hasRole('status')).toBe(false);
  });
  it('refreshes on retry but exposes rows only after the read is actually current', async () => {
    live.stale = true; live.error = 'Synthetic document read failed';
    await click(byName(screen(), 'Retry document read', 'button')); expect(live.refreshes).toBe(1);
    live.error = null; expect(hasRole('status')).toBe(true); expect(text(screen())).not.toContain(TITLE);
    live.stale = false; expect(text(screen())).toContain(TITLE); expect(hasRole('status')).toBe(false);
  });
  it.each(['parent', 'child'])('preserves verified read display for %s without a Storage operation', role => {
    Object.assign(h.app, { role }); expect(text(screen())).toContain(TITLE); expect(forbidden).not.toHaveBeenCalled();
  });
});
