import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesHubModule } from '@/components/modules/files-hub-module';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { VIEW_META, formatBytes, type FileView } from '@/lib/files/overview';
import type { Tables } from '@/lib/database.types';
import CloudPage, { generateMetadata as cloudMetadata } from '@/app/(app)/dashboard/files/cloud/page';
import VaultPage, { generateMetadata as vaultMetadata } from '@/app/(app)/dashboard/files/vault/page';
import SharedPage, { generateMetadata as sharedMetadata } from '@/app/(app)/dashboard/files/shared/page';

type Document = Tables<'documents'>;
type Props = Record<string, unknown> & { children?: ReactNode; action?: ReactNode };
const h = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, role: 'parent', familyId: 'family-1', slots: [] as unknown[], cursor: 0, docs: [] as Document[],
  tree: null as ReactNode, form: null as ReactElement<Props> | null, readError: null as unknown,
  success: vi.fn(), error: vi.fn(), refresh: vi.fn(), store: vi.fn(), discard: vi.fn(), signed: vi.fn(),
  insert: vi.fn(), update: vi.fn(), remove: vi.fn(), eq: vi.fn(), navigate: vi.fn(), cancel: vi.fn(), confirm: vi.fn(),
  feature: vi.fn(), assurance: vi.fn(),
}));
// Real controls, effects coordinator and catalogues; simulated hook state and a
// portal-only modal shim let the Node runner invoke the actual form handlers.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
  },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: h.familyId, userId: 'user-1', role: h.role }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: h.docs, loading: false, error: h.readError, refresh: h.refresh }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: h.success, error: h.error }) }));
vi.mock('@/components/ui/modal', async () => {
  const { createElement: element } = await import('react');
  return { Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactElement<Props> }) => {
    if (!open) return null;
    h.form = children;
    return element('section', { role: 'dialog', 'aria-label': title }, element('h2', null, title), children);
  } };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({
  insert: h.insert, update: (payload: unknown) => { h.update(payload); return { eq: h.eq }; },
  delete: () => { h.remove(); return { eq: h.eq }; },
}) }) }));
vi.mock('@/lib/storage/documents', () => ({
  uploadFamilyDocument: h.store, getDocumentSignedUrl: h.signed, removeFamilyDocument: h.discard,
  DOCUMENT_MAX_BYTES: 25 * 1024 * 1024, DOCUMENT_MAX_MB: 25,
}));
vi.mock('@/lib/utils/open-url', () => ({ preOpenWindow: () => ({ navigate: h.navigate, cancel: h.cancel }) }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: h.feature }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: h.assurance }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages(h.locale), key, params) };
});

const LOCALES: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const VIEWS = ['cloud', 'vault', 'shared'] as const;
function t(key: string, params?: Record<string, string | number>) { return translate(getMessages(h.locale), key, params); }
function escaped(text: string) { return renderToStaticMarkup(createElement('span', null, text)).slice(6, -7); }
function doc(overrides: Partial<Document> = {}): Document {
  return { id: 'file-1', family_id: 'family-1', title: 'Original.pdf', category: null,
    storage_path: 'family-1/cloud/original.pdf', mime_type: 'application/pdf', size_bytes: 2_517_000,
    is_secure: false, is_favorite: false, created_at: '2026-05-01T15:00:00Z', ...overrides } as Document;
}
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.action)];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<Props>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function find(predicate: (node: ReactElement<Props>) => boolean, tree = h.tree) {
  const node = nodes(tree).find(predicate); expect(node, 'real rendered control exists').toBeDefined(); return node!;
}
async function clickText(label: string) {
  const control = find((n) => typeof n.props.onClick === 'function' && textOf(n.props.children).trim() === label);
  await (control.props.onClick as () => unknown)();
}
async function clickName(name: string) {
  const control = find((n) => n.props['aria-label'] === name && typeof n.props.onClick === 'function');
  await (control.props.onClick as () => unknown)();
}
async function chooseFolder(label: string) {
  const control = find((n) => n.type === 'button' && typeof n.props['aria-pressed'] === 'boolean'
    && nodes(n.props.children).some((child) => child.type === 'span' && textOf(child.props.children) === label));
  await (control.props.onClick as () => unknown)();
}
function visibleTitles() {
  return nodes(h.tree).filter((n) => n.type === 'p' && typeof n.props.title === 'string').map((n) => n.props.title);
}
function search(value: string) {
  const input = find((n) => n.props['aria-label'] === t('filesHub.searchFiles'));
  (input.props.onChange as (event: unknown) => void)({ target: { value } });
}
function expandFields(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expandFields);
  if (!isValidElement<Props>(node)) return node;
  if (typeof node.type === 'function' && node.type.name === 'Field') return (node.type as (p: Props) => ReactNode)(node.props);
  return node.props.children === undefined ? node : cloneElement(node, undefined, expandFields(node.props.children));
}
function render(view: FileView = 'cloud') {
  h.cursor = 0; h.form = null;
  function Capture() { h.tree = expandFields(FilesHubModule({ view })); return h.tree; }
  const props = { locale: localeOrDefault(h.locale), source: 'cookie', messages: getMessages(h.locale), children: createElement(Capture) } as const;
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}
async function prepareUpload(view: FileView, category = '') {
  render(view); await clickText(t('filesHub.upload')); render(view);
  const file = new File(['sample'], 'Original file.pdf', { type: 'application/pdf' });
  const picker = find((n) => n.type === 'input' && n.props.type === 'file', h.form);
  (picker.props.onChange as (event: unknown) => void)({ target: { files: [file] } });
  render(view);
  const title = find((n) => n.props.placeholder === t('documents.eGPassportEmmaPdf'), h.form);
  (title.props.onChange as (event: unknown) => void)({ target: { value: ' My original title ' } });
  const folder = find((n) => n.props.placeholder === t('filesHub.eGTravelSchoolFinances'), h.form);
  (folder.props.onChange as (event: unknown) => void)({ target: { value: category } });
  render(view);
  return file;
}
async function submit() { await (h.form!.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() }); }

beforeEach(() => {
  h.locale = 'en-US'; h.role = 'parent'; h.familyId = 'family-1'; h.slots = []; h.cursor = 0; h.tree = null; h.form = null; h.readError = null; h.docs = [doc()];
  vi.clearAllMocks();
  h.store.mockResolvedValue({ path: 'family-1/path/result.pdf', error: null });
  h.discard.mockResolvedValue({ error: null }); h.insert.mockResolvedValue({ error: null }); h.eq.mockResolvedValue({ error: null });
  h.signed.mockResolvedValue({ url: 'https://example.com/signed-document', error: null }); h.confirm.mockReturnValue(true);
  h.feature.mockResolvedValue({ active: { familyId: 'family-1' } }); h.assurance.mockResolvedValue(undefined);
  vi.stubGlobal('window', { confirm: h.confirm });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(LOCALES)('Files hub in %s', (locale) => {
  beforeEach(() => { h.locale = locale; });

  it('renders all three view titles/descriptions and access-appropriate file subsets', async () => {
    h.docs = [doc(), doc({ id: 'secure-1', title: 'Private original.pdf', is_secure: true, is_favorite: true })];
    for (const view of VIEWS) {
      const html = render(view);
      expect(html).toContain(escaped(t(VIEW_META[view].titleKey)));
      expect(html).toContain(escaped(t(VIEW_META[view].descriptionKey)));
      for (const key of ['documents.files', 'adminContent.storageUsed', 'filesHub.secure', 'documents.shared']) expect(html).toContain(escaped(t(key)));
      expect(html.includes('Private original.pdf')).toBe(view !== 'shared');
      expect(html.includes('title="Original.pdf"')).toBe(view !== 'vault');
      expect(html).not.toMatch(/filesHubModule\.[a-zA-Z]/);
    }
    h.slots = []; render(); await clickText(t('filesHub.sort'));
    const html = render();
    for (const key of ['sortRecent', 'sortName', 'sortLargest']) expect(html).toContain(escaped(t(`filesHubModule.${key}`)));
    await clickText(t('filesHubModule.sortLargest')); expect(h.slots[1]).toBe('size');
    for (const key of Object.keys(getRawMessages('en-US')).filter((k) => k.startsWith('filesHubModule.'))) expect(getRawMessages(locale)[key], key).toBeTruthy();
  });

  it('formats counts, bytes and local timestamp dates without translating authored categories or titles', () => {
    h.docs = Array.from({ length: 1001 }, (_, i) => doc({ id: `file-${i}`, category: 'General' }));
    const html = render();
    expect(html).toContain(escaped(new Intl.NumberFormat(locale).format(1001)));
    expect(html).toContain(escaped(formatBytes(2_517_000, locale)));
    expect(html).toContain(escaped(new Date('2026-05-01T15:00:00Z').toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })));
    expect(html).toContain('General'); expect(html).toContain('Original.pdf');
    h.docs = [doc({ created_at: 'not-a-date' })];
    expect(render()).toContain(escaped(t('filesHubModule.uncategorized')));
    expect(render()).not.toContain('Invalid Date');
  });

  it('keeps uploaded folder IDs and secure flags independent of translated view names', async () => {
    for (const view of VIEWS) {
      h.slots = [];
      const file = await prepareUpload(view);
      const html = render(view);
      expect(html).toContain(escaped(t('filesHubModule.uploadTitle', { view: t(VIEW_META[view].titleKey) })));
      expect(html).toContain('Original file.pdf');
      await submit();
      expect(h.store).toHaveBeenLastCalledWith(expect.anything(), { familyId: 'family-1', folder: view, file });
      expect(h.insert).toHaveBeenLastCalledWith(expect.objectContaining({ family_id: 'family-1', created_by: 'user-1', category: null, title: 'My original title', storage_path: 'family-1/path/result.pdf', is_secure: view === 'vault' }));
      expect(h.success).toHaveBeenLastCalledWith(t('filesHubModule.fileUploaded'));
    }
    h.slots = []; await prepareUpload('shared', ' My custom category '); await submit();
    expect(h.store.mock.calls.at(-1)?.[1].folder).toBe('My custom category');
    expect(h.insert.mock.calls.at(-1)?.[0].category).toBe('My custom category');
  });

  it('refuses vault/sensitive uploads before storage and localizes the real coordinator reason', async () => {
    h.role = 'teen'; await prepareUpload('vault'); await submit();
    expect(h.error).toHaveBeenLastCalledWith(t('filesHubModule.refuseVault'));
    expect(h.store).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
    h.slots = []; await prepareUpload('shared', ' Medical '); await submit();
    expect(h.error).toHaveBeenLastCalledWith(t('filesHubModule.refuseSensitive', { category: 'medical' }));
    expect(h.store).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
  });

  it('uses translated accessible actions/confirmation while retaining file identity and visibility mutations', async () => {
    render(); await clickName(t('filesHubModule.addFavorite'));
    expect(h.update).toHaveBeenLastCalledWith({ is_favorite: true }); expect(h.eq).toHaveBeenLastCalledWith('id', 'file-1');
    await clickName(t('filesHubModule.moveVault'));
    expect(h.update).toHaveBeenLastCalledWith({ is_secure: true }); expect(h.success).toHaveBeenLastCalledWith(t('filesHubModule.movedVault'));
    h.docs = [doc({ is_secure: true, is_favorite: true })]; render();
    await clickName(t('filesHubModule.removeFavorite')); expect(h.update).toHaveBeenLastCalledWith({ is_favorite: false });
    await clickName(t('filesHubModule.moveShared')); expect(h.update).toHaveBeenLastCalledWith({ is_secure: false });
    expect(h.success).toHaveBeenLastCalledWith(t('filesHubModule.movedShared'));
    await clickName(t('filesHubModule.deleteFile', { name: 'Original.pdf' }));
    expect(h.confirm).toHaveBeenCalledWith(t('filesHubModule.deleteConfirm', { name: 'Original.pdf' }));
    expect(h.discard).toHaveBeenCalledWith(expect.anything(), 'family-1/cloud/original.pdf');
    expect(h.eq).toHaveBeenLastCalledWith('id', 'file-1');
  });

  it('renders translated empty/search/read/pending states and preserves upload cleanup on insert failure', async () => {
    h.docs = []; let html = render();
    expect(html).toContain(escaped(t('filesHubModule.emptyView', { view: t('filesHubModule.cloudTitle') })));
    h.slots[0] = 'Missing'; html = render();
    expect(html).toContain(escaped(t('filesHubModule.noMatches'))); expect(html).toContain(escaped(t('filesHubModule.searchHint')));
    h.readError = 'Raw backend details'; html = render();
    expect(html).toContain(escaped(t('filesHubModule.loadFailed'))); expect(html).not.toContain('Raw backend details');
    h.readError = null; h.slots = []; await prepareUpload('cloud');
    h.slots[7] = true; html = render(); expect(html).toContain(escaped(t('filesHubModule.uploading'))); h.slots[7] = false;
    h.insert.mockResolvedValue({ error: { message: 'Insert rejected' } }); await submit();
    expect(h.error).toHaveBeenLastCalledWith(t('avatarPicker.uploadFailed'));
    expect(h.discard).toHaveBeenCalledWith(expect.anything(), 'family-1/path/result.pdf');
    expect(h.success).not.toHaveBeenCalled();
  });

  it('shows translated file-selection validation and the actual size limit without recording a failed upload', async () => {
    render(); await clickText(t('filesHub.upload'));
    let html = render();
    expect(html).toContain(escaped(t('filesHubModule.chooseFile', { limit: 25 })));
    await submit(); expect(h.error).toHaveBeenLastCalledWith(t('filesHubModule.chooseAFileToUpload'));
    expect(h.store).not.toHaveBeenCalled();
    await prepareUpload('cloud');
    const oversized = new File(['sample'], 'Large.pdf', { type: 'application/pdf' });
    Object.defineProperty(oversized, 'size', { value: 25 * 1024 * 1024 + 1 });
    const picker = find((n) => n.type === 'input' && n.props.type === 'file', h.form);
    (picker.props.onChange as (event: unknown) => void)({ target: { files: [oversized] } });
    html = render(); expect(html).toContain('Large.pdf');
    h.store.mockResolvedValue({ path: null, error: 'Raw size error' });
    await submit(); expect(h.error).toHaveBeenLastCalledWith(t('filesHubModule.tooLarge', { limit: 25 }));
    expect(h.insert).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
  });

  it('localizes three metadata titles while preserving feature and AAL2 entry gates', async () => {
    for (const [view, metadata, page] of [['cloud', cloudMetadata, CloudPage], ['vault', vaultMetadata, VaultPage], ['shared', sharedMetadata, SharedPage]] as const) {
      expect(await metadata()).toEqual({ title: `${t(VIEW_META[view].titleKey)} | Bubaly` });
      const element = await page(); expect(element.props.view).toBe(view);
      expect(h.feature).toHaveBeenLastCalledWith('/dashboard/documents');
      expect(h.assurance).toHaveBeenLastCalledWith({ active: { familyId: 'family-1' } }, 'documents', `/dashboard/files/${view}`);
    }
  });

  it('selects uncategorized files separately from authored General, combines search and clears the selection', async () => {
    h.docs = [doc({ id: 'empty', title: 'Receipt.pdf', category: null }), doc({ id: 'blank', title: 'Blank.pdf', category: '   ' }), doc({ id: 'named', title: 'Named.pdf', category: 'General' })];
    const before = structuredClone(h.docs);
    const html = render(); expect(html).toContain(escaped(t('filesHubModule.uncategorized'))); expect(html).toContain('General');
    await chooseFolder(t('filesHubModule.uncategorized')); render();
    expect(visibleTitles().sort()).toEqual(['Blank.pdf', 'Receipt.pdf']);
    expect(find((n) => n.props['aria-label'] === t('filesHub.searchFiles')).props.value).toBe('');
    search('Receipt'); render(); expect(visibleTitles()).toEqual(['Receipt.pdf']);
    await chooseFolder('General'); render(); expect(visibleTitles()).toEqual(['Named.pdf']);
    expect(find((n) => n.props['aria-label'] === t('filesHub.searchFiles')).props.value).toBe('');
    await clickText(t('documents.allFiles')); render(); expect(visibleTitles()).toHaveLength(3);
    expect(h.docs).toEqual(before);
    expect(h.update).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled(); expect(h.store).not.toHaveBeenCalled();
  });
});

it('matches folder punctuation literally and ignores category selection from another view or household', async () => {
  const names = ['tax,school', 'name:"value"', '[a].*%_', 'General', 'general', 'null', 'uncategorized'];
  h.docs = names.map((category, i) => doc({ id: `file-${i}`, title: `Record ${i}.pdf`, category }));
  for (const [index, category] of names.entries()) {
    render(); await chooseFolder(category); render(); expect(visibleTitles()).toEqual([`Record ${index}.pdf`]);
  }
  h.docs = [doc({ id: 'secure', title: 'Vault.pdf', category: null, is_secure: true })];
  render('vault'); expect(visibleTitles()).toEqual(['Vault.pdf']);
  h.familyId = 'family-2'; h.docs = [doc({ id: 'new', title: 'New household.pdf', family_id: 'family-2', category: null })];
  render(); expect(visibleTitles()).toEqual(['New household.pdf']);
});

it('keeps All Files available when a selected category has no remaining documents', async () => {
  h.docs = [doc({ category: 'General' })]; render(); await chooseFolder('General');
  h.docs = []; const html = render(); expect(html).toContain(escaped(t('filesHubModule.noMatches')));
  await clickText(t('documents.allFiles'));
  expect(render()).toContain(escaped(t('filesHubModule.emptyView', { view: t('filesHubModule.cloudTitle') })));
});

it.each(['teen', 'child', 'caregiver', 'guest'])('does not offer visibility changes to %s', (role) => {
  h.role = role; const html = render();
  expect(html).not.toContain(`aria-label="${escaped(t('filesHubModule.moveVault'))}"`);
  expect(html).not.toContain(`aria-label="${escaped(t('filesHubModule.moveShared'))}"`);
});

it('localizes signed-link failure and keeps the pre-opened tab closed', async () => {
  h.locale = 'fr-FR'; h.signed.mockResolvedValue({ url: null, error: 'Raw signed URL failure' });
  render(); await clickText(t('filesHub.open'));
  expect(h.error).toHaveBeenCalledWith(t('filesHubModule.openFailed')); expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.navigate).not.toHaveBeenCalled();
});
