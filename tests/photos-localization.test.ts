import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDistanceToNow } from 'date-fns';
import { de, enUS, es, fr, it as italian, nl, pt } from 'date-fns/locale';
import { PhotosModule } from '@/components/modules/photos-module';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { generateMetadata } from '@/app/(app)/dashboard/photos/page';
import { FAMILY_MEDIA_MAX_BYTES } from '@/lib/storage/family-media';
import type { Tables } from '@/lib/database.types';

type Photo = Tables<'family_photos'>;
type Album = Tables<'family_albums'>;
type Props = Record<string, unknown> & { children?: ReactNode; action?: ReactNode };
const h = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, slots: [] as unknown[], cursor: 0, tree: null as ReactNode,
  photos: [] as Photo[], albums: [] as Album[], mutationError: null as unknown,
  photoInsertError: null as unknown, albumInsertError: null as unknown,
  success: vi.fn(), error: vi.fn(), refresh: vi.fn(), insert: vi.fn(), update: vi.fn(), eq: vi.fn(),
  upload: vi.fn(), remove: vi.fn(), bucket: vi.fn(), publicUrl: vi.fn(),
}));

// The real module, local forms, fields, provider and HTML renderer run here.
// Simulated hook state lets Node exercise handlers; only the browser portal and
// external data/storage boundaries are replaced. This does not claim device QA.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [h.slots[index], (next: unknown) => {
      h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next;
    }];
  },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', userId: 'user-1' }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: ({ table }: { table: string }) => ({
    data: table === 'family_albums' ? h.albums : h.photos, loading: false, error: null, refresh: h.refresh,
  }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: h.success, error: h.error }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/ui/modal', async () => {
  const { createElement: element } = await import('react');
  return { Modal: ({ title, children }: { title: string; children: ReactNode }) =>
    element('section', { role: 'dialog', 'aria-label': title }, element('h2', null, title), children) };
});
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => ({
    insert: (value: Record<string, unknown>) => {
      h.insert(table, value);
      if (table === 'family_albums') return Promise.resolve({ error: h.albumInsertError });
      return { select: () => ({ single: async () => ({
        data: h.photoInsertError ? null : { id: 'inserted-photo' }, error: h.photoInsertError,
      }) }) };
    },
    update: (value: Record<string, unknown>) => {
      h.update(table, value);
      return { eq: async (column: string, id: string) => {
        h.eq(column, id);
        if (!h.mutationError) h.photos = h.photos.map((p) => p.id === id ? { ...p, ...value } : p);
        return { error: h.mutationError };
      } };
    },
    delete: () => ({ eq: async (column: string, id: string) => {
      h.eq(column, id); return { error: h.mutationError };
    } }),
  }),
  storage: { from: (bucket: string) => {
    h.bucket(bucket); return { upload: h.upload, remove: h.remove, getPublicUrl: h.publicUrl };
  } },
}) }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => tr(messages(h.locale), key) };
});

const LOCALES: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const DATE_LOCALES = { 'en-US': enUS, 'de-DE': de, 'es-ES': es, 'fr-FR': fr, 'it-IT': italian, 'nl-NL': nl, 'pt-PT': pt };
const KINDS = ['general', 'vacation', 'school', 'sports', 'milestones', 'holiday', 'birthday', 'other'];
const NOW = new Date('2026-09-09T12:00:00');
function t(key: string, params?: Record<string, string | number>) { return translate(getMessages(h.locale), key, params); }
function escaped(value: string) { return renderToStaticMarkup(createElement('span', null, value)).slice(6, -7); }
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<Props>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.action)];
}
function find(predicate: (node: ReactElement<Props>) => boolean) {
  const node = nodes(h.tree).find(predicate);
  expect(node, 'rendered control exists').toBeDefined(); return node!;
}
function clickNode(node: ReactElement<Props>) {
  return (node.props.onClick as (event: unknown) => unknown)({ stopPropagation: vi.fn(), preventDefault: vi.fn() });
}
function clickText(label: string) {
  return clickNode(find((n) => typeof n.props.onClick === 'function' && textOf(n.props.children).trim() === label));
}
function clickLabel(label: string) { return clickNode(find((n) => n.props['aria-label'] === label)); }
function change(placeholder: string, value: string) {
  const node = find((n) => n.props.placeholder === placeholder);
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
}
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Props>(node)) return node;
  if (typeof node.type === 'function' && ['NewAlbumModal', 'UploadModal', 'EditPhotoModal', 'Field'].includes(node.type.name)) {
    return expand((node.type as (props: Props) => ReactNode)(node.props));
  }
  return cloneElement(node, {
    ...(node.props.children !== undefined ? { children: expand(node.props.children) } : {}),
    ...(node.props.action !== undefined ? { action: expand(node.props.action) } : {}),
  });
}
function Capture() { h.tree = expand(PhotosModule()); return h.tree; }
function render() {
  h.cursor = 0;
  const providerProps = {
    locale: localeOrDefault(h.locale), source: 'cookie', messages: getMessages(h.locale), children: createElement(Capture),
  } as const;
  return renderToStaticMarkup(createElement(LocaleProvider, providerProps));
}
function photo(id = 'photo-1', overrides: Partial<Photo> = {}): Photo {
  return { id, family_id: 'family-1', album_id: 'album-general', uploaded_by: 'user-1',
    storage_path: `family-1/photos/${id}.jpg`, url: `https://example.com/${id}.jpg`, media_type: 'image',
    caption: null, tags: [], size_bytes: 12, is_favorite: false, created_at: NOW.toISOString(), ...overrides } as Photo;
}
function album(kind = 'general'): Album {
  return { id: `album-${kind}`, family_id: 'family-1', created_by: 'user-1', name: `Stored ${kind}`, kind,
    description: 'Stored description', created_at: NOW.toISOString() } as Album;
}
function file(name: string, type: string, size = 12) { return { name, type, size } as File; }
function chooseFiles(files: File[]) {
  const input = find((n) => n.type === 'input' && n.props.type === 'file');
  (input.props.onChange as (event: unknown) => void)({ target: { files } });
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function openAll() { render(); clickText(t('photosModule.allPhotos')); return render(); }
function openUpload() { render(); clickText(t('photos.upload')); return render(); }

beforeEach(() => {
  h.locale = 'en-US'; h.slots = []; h.cursor = 0; h.tree = null; h.photos = []; h.albums = [];
  h.mutationError = null; h.photoInsertError = null; h.albumInsertError = null;
  for (const mock of [h.success, h.error, h.refresh, h.insert, h.update, h.eq, h.upload, h.remove, h.bucket, h.publicUrl]) mock.mockReset();
  h.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  h.remove.mockResolvedValue({ error: null });
  h.publicUrl.mockImplementation((path: string) => ({ data: { publicUrl: `https://example.com/${path}` } }));
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-preview');
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('DataTransfer', class {
    files: File[] = []; items = { add: (value: File) => { this.files.push(value); } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(LOCALES)('Photos in %s', (locale) => {
  beforeEach(() => { h.locale = locale; });

  it('renders translated tabs, album kinds and counts without translating saved content', () => {
    h.albums = KINDS.map(album);
    h.photos = [photo(), photo('two', { album_id: 'album-vacation' }), photo('three', { album_id: 'album-vacation' })];
    const html = render();
    for (const kind of KINDS) {
      const key = `photosModule.kind${kind[0].toUpperCase()}${kind.slice(1)}`;
      expect(getRawMessages(locale)[key]).toBeTruthy();
      expect(html).toContain(escaped(t(key)));
      expect(html).toContain(`Stored ${kind}`);
    }
    for (const key of ['photosModule.allPhotos', 'photosModule.favorites', 'photosModule.recents']) expect(html).toContain(escaped(t(key)));
    expect(html).toContain(escaped(t('photosModule.photoCount', { count: 1 })));
    expect(html).toContain(escaped(t('photosModule.photosCount', { count: 2 })));
    expect(html).toContain(`aria-label="${escaped(t('photosModule.showList'))}"`);
    expect(html).not.toMatch(/photosModule\.|\{count\}/);
  });

  it('uses named favorite and unfavorite actions in the grid, list and lightbox', async () => {
    h.photos = [photo()];
    let html = openAll();
    expect(html).toContain(`aria-label="${escaped(t('photosModule.addFavorite'))}"`);
    expect(t('photosModule.addFavorite')).not.toBe(t('photosModule.removeFavorite'));
    clickLabel(t('photosModule.addFavorite')); await flush();
    expect(h.update).toHaveBeenLastCalledWith('family_photos', { is_favorite: true });
    expect(h.eq).toHaveBeenLastCalledWith('id', 'photo-1');
    html = render(); expect(html).toContain(`aria-label="${escaped(t('photosModule.removeFavorite'))}"`);
    clickLabel(t('photosModule.showList'));
    html = render(); expect(html).toContain(`aria-label="${escaped(t('photosModule.removeFavorite'))}"`);
    clickLabel(t('photosModule.removeFavorite')); await flush();
    expect(h.update).toHaveBeenLastCalledWith('family_photos', { is_favorite: false });
    render();
    const row = find((n) => n.type === 'div' && typeof n.props.onClick === 'function' && String(n.props.className).includes('border-b'));
    clickNode(row); html = render();
    for (const key of ['photos.close', 'photos.deletePhoto', 'photosModule.download', 'photosModule.addFavorite']) {
      expect(html).toContain(`aria-label="${escaped(t(key))}"`);
    }
    const controls = nodes(h.tree).filter((n) => n.props['aria-label'] === t('photosModule.addFavorite'));
    expect(controls).toHaveLength(2); // list plus the open lightbox
    clickNode(controls[1]); await flush();
    expect(h.update).toHaveBeenLastCalledWith('family_photos', { is_favorite: true });
    html = render(); expect(html.match(new RegExp('aria-label=', 'g'))!.length).toBeGreaterThan(3);
    const remove = nodes(h.tree).filter((n) => n.props['aria-label'] === t('photosModule.removeFavorite'));
    expect(remove).toHaveLength(2);
    clickNode(remove[1]); await flush();
    expect(h.update).toHaveBeenLastCalledWith('family_photos', { is_favorite: false });
    expect(h.photos[0].caption).toBeNull();
  });

  it('opens the real album form and saves machine category plus unmodified user text', async () => {
    render(); clickText(t('photos.album')); let html = render();
    for (const kind of KINDS) expect(html).toContain(escaped(t(`photosModule.kind${kind[0].toUpperCase()}${kind.slice(1)}`)));
    change(t('photosModule.summer2025EmmaSBirthday'), '  Summer memories  ');
    change(t('photos.whatIsThisAlbumAbout'), '  Keep these words  ');
    clickText(t('photosModule.kindBirthday')); render();
    const form = find((n) => n.type === 'form');
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
    expect(h.insert).toHaveBeenLastCalledWith('family_albums', {
      family_id: 'family-1', created_by: 'user-1', name: 'Summer memories', description: 'Keep these words', kind: 'birthday',
    });
    html = render(); expect(html).not.toContain('role="dialog"');
  });

  it('formats local today, tomorrow and relative timestamps and tolerates invalid dates', () => {
    const tomorrow = new Date(NOW); tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(NOW); yesterday.setDate(yesterday.getDate() - 2);
    h.photos = [photo(), photo('tomorrow', { created_at: tomorrow.toISOString() }), photo('older', { created_at: yesterday.toISOString() }), photo('bad', { created_at: 'not-a-date' })];
    openAll(); clickLabel(t('photosModule.showList')); const html = render();
    const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(NOW);
    expect(html).toContain(escaped(t('photosModule.todayAt', { time: clock })));
    expect(html).toContain(escaped(t('photosModule.tomorrowAt', { time: clock })));
    expect(html).toContain(escaped(formatDistanceToNow(yesterday, { addSuffix: true, locale: DATE_LOCALES[locale as keyof typeof DATE_LOCALES] })));
    expect(html).not.toMatch(/Invalid Date|not-a-date/);
    expect(h.photos[0].created_at).toBe(NOW.toISOString());
    expect(h.photos[1].created_at).toBe(tomorrow.toISOString());
  });

  it('localizes file selection and upload result while preserving storage and row identity', async () => {
    openUpload(); const files = [file('holiday.jpg', 'image/jpeg'), file('clip.mp4', 'video/mp4', 44)];
    chooseFiles(files); let html = render();
    expect(html).toContain(escaped(t('photosModule.selectedFiles', { count: 2 })));
    clickText(t('photosModule.uploadFiles', { count: 2 })); await flush();
    expect(h.upload).toHaveBeenNthCalledWith(1, expect.stringMatching(/^family-1\/photos\/.+\.jpg$/), files[0], { upsert: false, cacheControl: '31536000' });
    expect(h.upload).toHaveBeenNthCalledWith(2, expect.stringMatching(/^family-1\/videos\/.+\.mp4$/), files[1], { upsert: false, cacheControl: '31536000' });
    expect(h.bucket.mock.calls.every(([bucket]) => bucket === 'family-media')).toBe(true);
    expect(h.insert).toHaveBeenNthCalledWith(1, 'family_photos', expect.objectContaining({ family_id: 'family-1', uploaded_by: 'user-1', album_id: null, media_type: 'image', size_bytes: 12 }));
    expect(h.insert).toHaveBeenNthCalledWith(2, 'family_photos', expect.objectContaining({ family_id: 'family-1', uploaded_by: 'user-1', album_id: null, media_type: 'video', size_bytes: 44 }));
    expect(h.success).toHaveBeenLastCalledWith(t('photosModule.uploadedFiles', { count: 2 }));
    html = render(); expect(html).not.toContain('role="dialog"');
  });

  it('translates empty-library and empty-album states and saves the actual caption', async () => {
    expect(openAll()).toContain(escaped(t('photosModule.emptyPhotos')));
    h.albums = [album()];
    clickNode(find((n) => n.type === 'button' && String(n.props.className).includes('tab-item') && textOf(n.props.children) === t('photos.albums'))); render();
    clickNode(find((n) => n.type === 'button' && textOf(n.props.children).includes('Stored general')));
    expect(render()).toContain(escaped(t('photosModule.emptyAlbum')));
    h.photos = [photo('one', { caption: 'Original caption' })]; render();
    clickLabel(t('photos.editPhotoDetails')); render();
    change(t('photos.addACaption'), 'A caption in my own words'); render();
    await clickText(t('photos.save')); await flush();
    expect(h.update).toHaveBeenLastCalledWith('family_photos', { caption: 'A caption in my own words' });
    expect(h.eq).toHaveBeenLastCalledWith('id', 'one');
    expect(h.photos[0].caption).toBe('A caption in my own words');
  });

  it('resolves the page title from the request locale', async () => {
    expect(await generateMetadata()).toEqual({ title: t('photosModule.familyPhotos') });
  });
});

it('renders live attempted progress distinctly from successful uploads and locks the dropzone while busy', async () => {
  h.locale = 'de-DE'; let resolveSecond!: (value: unknown) => void;
  h.upload.mockResolvedValueOnce({ data: null, error: { message: 'provider failure' } })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
  openUpload(); chooseFiles([file('failed.jpg', 'image/jpeg'), file('saved.jpg', 'image/jpeg')]); render();
  clickText(t('photosModule.uploadFiles', { count: 2 })); await flush();
  const html = render();
  expect(html).toContain(escaped(t('photosModule.processedProgress', { done: 1, total: 2 })));
  expect(html).toContain(`aria-label="${escaped(t('photosModule.uploadProgress', { done: 1, total: 2 }))}"`);
  expect(html).toContain('aria-valuenow="50"');
  const drop = find((n) => n.props.role === 'button');
  expect(drop.props['aria-disabled']).toBe(true); expect(drop.props.tabIndex).toBe(-1);
  expect(h.error).toHaveBeenLastCalledWith(t('photosModule.uploadFailed', { name: 'failed.jpg' }));
  expect(h.success).not.toHaveBeenCalled();
  resolveSecond({ data: { path: 'family-1/photos/saved.jpg' }, error: null }); await flush();
  expect(h.success).toHaveBeenLastCalledWith(t('photosModule.uploadedFile', { count: 1 }));
  expect(h.insert).toHaveBeenCalledTimes(1);
});

it('skips oversized media before storage, names failed files, and never claims a failed row was saved', async () => {
  h.locale = 'fr-FR'; openUpload();
  chooseFiles([file('huge.jpg', 'image/jpeg', FAMILY_MEDIA_MAX_BYTES + 1)]); render();
  clickText(t('photosModule.uploadFile', { count: 1 })); await flush();
  expect(h.error).toHaveBeenLastCalledWith(t('photosModule.skippedFile', { count: 1, limit: '25 MB' }));
  expect(h.upload).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
  chooseFiles([file('small.jpg', 'image/jpeg')]); render();
  h.photoInsertError = { message: 'save failed' };
  clickText(t('photosModule.uploadFile', { count: 1 })); await flush();
  expect(h.error).toHaveBeenLastCalledWith(t('photosModule.theFileUploadedButIts'));
  expect(h.remove).toHaveBeenCalledWith([h.upload.mock.calls[0][0]]);
  expect(h.success).not.toHaveBeenCalled();
});

it('preserves keyboard browse access and changes an open upload form locale without losing files', () => {
  openUpload(); chooseFiles([file('mine.jpg', 'image/jpeg')]); render();
  const input = find((n) => n.type === 'input' && n.props.type === 'file');
  const click = vi.fn();
  (input as unknown as { ref: { current: unknown } }).ref.current = { click };
  const drop = find((n) => n.props.role === 'button');
  const key = drop.props.onKeyDown as (event: unknown) => void;
  key({ key: 'Enter', preventDefault: vi.fn() }); key({ key: ' ', preventDefault: vi.fn() });
  expect(click).toHaveBeenCalledTimes(2); expect(drop.props.tabIndex).toBe(0);
  h.locale = 'pt-PT'; const html = render();
  expect(html).toContain(escaped(t('photosModule.selectedFile', { count: 1 })));
  expect(html).toContain('alt="mine.jpg"');
  expect(html).toContain(`aria-label="${escaped(t('photos.uploadPhotosOrVideos'))}"`);
});

it('preserves row-first deletion and refuses storage removal or success after a row failure', async () => {
  h.photos = [photo()]; openAll();
  clickNode(find((n) => n.type === 'div' && typeof n.props.onClick === 'function' && String(n.props.className).includes('break-inside-avoid'))); render();
  h.mutationError = { message: 'delete failed' };
  clickLabel(t('photos.deletePhoto')); await flush();
  expect(h.eq).toHaveBeenLastCalledWith('id', 'photo-1');
  expect(h.remove).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
  h.mutationError = null; clickLabel(t('photos.deletePhoto')); await flush();
  expect(h.remove).toHaveBeenLastCalledWith(['family-1/photos/photo-1.jpg']);
  expect(h.success).toHaveBeenLastCalledWith(t('photosModule.photoDeleted'));
});
