// N15 — Create Memory said "Memory created!" with the number of photos PICKED.
//
// A file whose upload or row failed got a toast and was skipped; the save
// bailed out only when NOTHING was saved. So five picks with two lost to a
// storage error ended on "“Beach day” is saved to your family memories (5
// photos)", showing the first pick's thumbnail whether or not it was saved,
// and the journey was recorded as a success.
//
// Driven through the REAL component against an in-memory database and a
// storage bucket that refuses chosen files (tests/helpers/module-harness.tsx).
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, has, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const io = vi.hoisted(() => ({ refusedUploads: new Set<string>(), journey: { start: () => {}, step: () => {}, complete: (() => {}) as () => void, abandon: () => {} } }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// The harness client, with a public bucket's URL and an upload that a test can refuse per file.
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return {
    createClient: () => {
      const client = clientFor(h);
      return {
        ...client,
        storage: {
          from: (name: string) => {
            const bucket = client.storage.from(name);
            return {
              ...bucket,
              upload: async (path: string, file: File) => (io.refusedUploads.has(file.name)
                ? { data: null, error: { message: 'Upload refused' } }
                : bucket.upload(path)),
              getPublicUrl: (path: string) => ({ data: { publicUrl: `https://public.invalid/${name}/${path}` } }),
            };
          },
        },
      };
    },
  };
});
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock('@/components/ui/camera-capture', () => ({ CameraCapture: () => null }));
vi.mock('@/lib/analytics/use-journey', () => ({ useJourney: () => io.journey }));

const { CreateMemory } = await import('@/components/memories/create-memory');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: InMemorySupabase;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] };
  io.refusedUploads = new Set();
  io.journey.complete = vi.fn();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(CreateMemory));
const image = (name: string) => ({ name, type: 'image/jpeg', size: 2048 }) as File;
const thumbnail = (tree: ReactNode) => nodes(tree).find((n) => n.type === 'img')?.props.src;

async function saveMemory(names: string[]): Promise<ReactNode> {
  const picker = nodes(screen()).find((n) => n.type === 'input' && n.props.type === 'file') as Node;
  (picker.props.onChange as (e: unknown) => void)({ target: { files: names.map(image), value: '' } });
  change(nodes(screen()).find((n) => n.props.placeholder === t('createMemory.beachDayFirstStepsGrandma')) as Node, 'Beach day');
  await click(byName(screen(), t('createMemory.saveMemoryPhotos', { n: names.length }), 'button'));
  await settle();
  return screen();
}

describe('a memory says how many photos it kept', () => {
  it('two of three saved: the screen says two, shows a saved photo, and says one is missing', async () => {
    io.refusedUploads.add('first.jpg');

    const done = await saveMemory(['first.jpg', 'second.jpg', 'third.jpg']);

    expect(db.table('family_photos')).toHaveLength(2);
    expect(has(done, t('createMemory.memoryCreated'))).toBe(true);
    expect(has(done, '(2 photos)')).toBe(true);
    expect(has(done, '(3 photos)')).toBe(false);
    expect(has(done, t('createMemory.someOfThePhotosWereNotSaved', { saved: 2, total: 3, failed: 1 }))).toBe(true);
    expect(thumbnail(done)).toBe('blob:second.jpg');
    expect(io.journey.complete).not.toHaveBeenCalled();
  });

  it('trying the missing photo again saves exactly that one, and only then is it complete', async () => {
    io.refusedUploads.add('first.jpg');
    await saveMemory(['first.jpg', 'second.jpg', 'third.jpg']);
    io.refusedUploads.clear();

    await click(byName(screen(), t('createMemory.tryTheMissingPhotosAgain'), 'button'));
    await settle();
    const done = screen();

    expect(db.table('family_photos')).toHaveLength(3);
    expect(has(done, '(3 photos)')).toBe(true);
    expect(has(done, t('createMemory.someOfThePhotosWereNotSaved', { saved: 2, total: 3, failed: 1 }))).toBe(false);
    expect(io.journey.complete).toHaveBeenCalledTimes(1);
  });

  it('every photo saved: no warning, and the journey completes', async () => {
    const done = await saveMemory(['first.jpg', 'second.jpg']);

    expect(has(done, '(2 photos)')).toBe(true);
    expect(nodes(done).some((n) => n.props.role === 'alert')).toBe(false);
    expect(thumbnail(done)).toBe('blob:first.jpg');
    expect(io.journey.complete).toHaveBeenCalledTimes(1);
  });
});
