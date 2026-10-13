import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, click, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The library player's row (app/(app)/dashboard/library/player.tsx ItemRow),
// driven as a listener drives it: Play, the element's own play / timeupdate /
// pause events, and the progress writes those cause.
//
//   S7   when the page could not read this person's places, every row showed 0
//        and the first pause — or fifteen seconds of playback — wrote a position
//        over the real one, two hours into an audiobook, with no way back
//   S19  a finished item stayed finished for ever: a replay's position was
//        saved, but every later visit started it at 0:00 (resumeFrom of a
//        completed row), and its fifteen-second saves never fired at all
//
// And the review of those (AUD-1040-LIBRARY-BOUNDARIES):
//
//   2    a row that played while the place was unknown, then got the real
//        place from a revalidation (Save, Download), wrote the stand-in
//        position over the place just recovered
//   3    a replay cleared "finished" as its reset was SENT, so a later
//        position-only save could land while the reset failed, leaving the
//        stored row finished — the next visit restarted at 0:00
//   1    the offline library keeps only named audio, the one kind
//        /library/media gives every member, a child or a teen included

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const progress = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/library/actions', () => ({
  saveProgressAction: progress.save,
  addBookAction: vi.fn(), refreshFeedAction: vi.fn(), subscribeFeedAction: vi.fn(), unsubscribeFeedAction: vi.fn(),
}));

const { ItemRow } = await import('@/app/(app)/dashboard/library/player');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

type Item = Parameters<typeof ItemRow>[0]['item'];
const BOOK: Item = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Wonder (audiobook)', author: null,
  mediaUrl: 'https://cdn.example.com/wonder.mp3', pageUrl: null, durationSeconds: 30_000,
  positionSeconds: 0, saved: false, offline: false, completed: false,
};

/** A stand-in <audio>: what the row reads and what it calls. */
function fakeAudio() {
  return { currentTime: 0, paused: true, play: vi.fn(async () => {}), pause: vi.fn() };
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  progress.save.mockReset().mockResolvedValue({ ok: true, message: 'Saved.' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Mount the row with a stand-in element behind its ref, press Play, and let it start. */
async function playing(item: Item) {
  const screen = (): ReactNode => render(h.hooks, createElement(ItemRow, { item }));
  const tree = screen();
  const element = nodes(tree).find((n) => n.type === 'audio') as Node;
  const audio = fakeAudio();
  (element.props.ref as { current: unknown }).current = audio;
  await click(byName(tree, t('uiText.play')));
  audio.paused = false;
  (element.props.onPlay as () => void)();
  const events = () => nodes(screen()).find((n) => n.type === 'audio') as Node;
  return {
    audio,
    press: async () => {
      await click(byName(screen(), t('uiText.play')));
      audio.paused = false;
      (events().props.onPlay as () => void)();
    },
    timeUpdate: async (at: number) => { audio.currentTime = at; (events().props.onTimeUpdate as () => void)(); await settle(); },
    pause: async () => { audio.paused = true; (events().props.onPause as () => void)(); await settle(); },
    end: async () => { (events().props.onEnded as () => void)(); await settle(); },
  };
}

describe('S7 — a place that could not be read is never written over', () => {
  const UNREAD: Item = { ...BOOK, positionSeconds: 0, progressUnknown: true };

  it('fifteen seconds of playback write nothing', async () => {
    const row = await playing(UNREAD);
    await row.timeUpdate(15);
    await row.timeUpdate(31);
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('a pause writes nothing', async () => {
    const row = await playing(UNREAD);
    await row.timeUpdate(3);
    await row.pause();
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('a row whose place WAS read still saves it', async () => {
    const row = await playing({ ...BOOK, positionSeconds: 7200 });
    expect(row.audio.currentTime).toBe(7200);
    await row.timeUpdate(7216);
    expect(progress.save).toHaveBeenCalledWith({ itemId: BOOK.id, positionSeconds: 7216 });
  });
});

describe('S19 — playing a finished item again un-finishes it', () => {
  const FINISHED: Item = { ...BOOK, positionSeconds: 29_998, completed: true };

  it('the replay starts at the top and its first save says it is no longer finished', async () => {
    const row = await playing(FINISHED);
    expect(row.audio.currentTime).toBe(0);

    // The fifteen-second save fires, measured from where the replay started.
    await row.timeUpdate(16);
    expect(progress.save).toHaveBeenCalledWith({ itemId: BOOK.id, positionSeconds: 16, completed: false });

    // Later saves are ordinary position saves.
    await row.timeUpdate(40);
    expect(progress.save).toHaveBeenLastCalledWith({ itemId: BOOK.id, positionSeconds: 40 });
  });

  it('a replay paused part-way is saved as not finished', async () => {
    const row = await playing(FINISHED);
    await row.timeUpdate(9600);
    await row.pause();
    expect(progress.save.mock.calls.map(([input]) => input)).toContainEqual({ itemId: BOOK.id, positionSeconds: 9600, completed: false });
  });

  it('a replay that reaches the end is finished again, and the pause at the end does not race it', async () => {
    const row = await playing({ ...FINISHED, positionSeconds: 0 });
    await row.timeUpdate(29_998);
    await row.pause();
    await row.end();
    const writes = progress.save.mock.calls.map(([input]) => input as Record<string, unknown>);
    expect(writes.filter((w) => w.completed === false).every((w) => (w.positionSeconds as number) < 29_995)).toBe(true);
    expect(writes.at(-1)).toEqual({ itemId: BOOK.id, completed: true });
  });
});

describe('2 — a place recovered while the row is open is not written over', () => {
  const UNREAD: Item = { ...BOOK, positionSeconds: 0, progressUnknown: true };

  /**
   * Mount the row without the place and press Play; `recover` hands the SAME
   * mounted row the real place, as a Save or a Download revalidating the page does.
   */
  async function unknownThenKnown() {
    let item = UNREAD;
    const screen = (): ReactNode => render(h.hooks, createElement(ItemRow, { item }));
    const tree = screen();
    const audio = fakeAudio();
    ((nodes(tree).find((n) => n.type === 'audio') as Node).props.ref as { current: unknown }).current = audio;
    const events = () => nodes(screen()).find((n) => n.type === 'audio') as Node;
    const press = async () => {
      await click(byName(screen(), t('uiText.play')));
      audio.paused = false;
      (events().props.onPlay as () => void)();
    };
    return {
      audio, press,
      recover: (known: Item) => { item = known; screen(); },
      timeUpdate: async (at: number) => { audio.currentTime = at; (events().props.onTimeUpdate as () => void)(); await settle(); },
      pause: async () => { audio.paused = true; (events().props.onPause as () => void)(); await settle(); },
      end: async () => { (events().props.onEnded as () => void)(); await settle(); },
    };
  }

  it('reaching the end from the stand-in writes nothing either, before or after the place arrives', async () => {
    const row = await unknownThenKnown();
    await row.press();
    await row.timeUpdate(29_998);
    await row.end();
    row.recover({ ...BOOK, positionSeconds: 7200 });
    await row.end();
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('playback that began from the stand-in writes nothing once the place arrives — not on time, not on pause', async () => {
    const row = await unknownThenKnown();
    await row.press();
    await row.timeUpdate(20);
    row.recover({ ...BOOK, positionSeconds: 7200 });
    await row.timeUpdate(40);
    await row.timeUpdate(60);
    await row.pause();
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('the next Play starts from the recovered place, and saves resume from there', async () => {
    const row = await unknownThenKnown();
    await row.press();
    await row.timeUpdate(20);
    row.recover({ ...BOOK, positionSeconds: 7200 });
    await row.pause();
    await row.press();
    expect(row.audio.currentTime).toBe(7200);
    await row.timeUpdate(7216);
    expect(progress.save.mock.calls.map(([input]) => input)).toEqual([{ itemId: BOOK.id, positionSeconds: 7216 }]);
  });

  it('a row not yet played takes up the recovered place, finished included', async () => {
    const row = await unknownThenKnown();
    row.recover({ ...BOOK, positionSeconds: 29_998, completed: true });
    await row.press();
    expect(row.audio.currentTime).toBe(0);
    await row.timeUpdate(16);
    expect(progress.save).toHaveBeenCalledWith({ itemId: BOOK.id, positionSeconds: 16, completed: false });
  });
});

describe('3 — a replay stays un-finished in every save until one lands', () => {
  const FINISHED: Item = { ...BOOK, positionSeconds: 29_998, completed: true };
  const writes = () => progress.save.mock.calls.map(([input]) => input);

  it('a failed first reset cannot be overtaken by a position-only save', async () => {
    let failFirst!: () => void;
    progress.save.mockImplementationOnce(() => new Promise((resolve) => {
      failFirst = () => resolve({ ok: false, error: 'Could not save.' });
    }));
    const row = await playing(FINISHED);
    await row.timeUpdate(16);
    await row.timeUpdate(40);
    failFirst();
    await settle();
    await row.timeUpdate(60);
    expect(writes()).toEqual([
      { itemId: BOOK.id, positionSeconds: 16, completed: false },
      // Still un-finishing: the first had not landed when this was sent.
      { itemId: BOOK.id, positionSeconds: 40, completed: false },
      // The second landed, so the row is un-finished whatever the first did.
      { itemId: BOOK.id, positionSeconds: 60 },
    ]);
  });

  it('a reset that never lands is sent again with the next save', async () => {
    progress.save.mockResolvedValueOnce({ ok: false, error: 'Could not save.' });
    const row = await playing(FINISHED);
    await row.timeUpdate(16);
    await row.timeUpdate(40);
    expect(writes().at(-1)).toEqual({ itemId: BOOK.id, positionSeconds: 40, completed: false });
  });

  // What the server STORES, not what the client sent: a write is applied when
  // it is processed. Sent together, the end's `completed: true` could be
  // processed before the replay's `completed: false` and be overwritten by it.
  it('a replay that ends while its reset is still in flight is stored finished', async () => {
    const stored: Record<string, unknown> = { positionSeconds: 29_998, completed: true };
    let landFirst!: () => void;
    progress.save
      .mockImplementationOnce((input: Record<string, unknown>) => new Promise((resolve) => {
        landFirst = () => { Object.assign(stored, input); resolve({ ok: true, message: 'Saved.' }); };
      }))
      .mockImplementation(async (input: Record<string, unknown>) => { Object.assign(stored, input); return { ok: true, message: 'Saved.' }; });
    const row = await playing(FINISHED);
    await row.timeUpdate(16);
    await row.end();
    // The end's write waits for the reset ahead of it.
    expect(progress.save).toHaveBeenCalledTimes(1);

    landFirst();
    await settle();
    expect(writes()).toEqual([
      { itemId: BOOK.id, positionSeconds: 16, completed: false },
      { itemId: BOOK.id, completed: true },
    ]);
    expect(stored.completed).toBe(true);
  });

  it('a reset that lands after the item ended again does not un-finish it', async () => {
    let landFirst!: () => void;
    progress.save.mockImplementationOnce(() => new Promise((resolve) => {
      landFirst = () => resolve({ ok: true, message: 'Saved.' });
    }));
    const row = await playing(FINISHED);
    await row.timeUpdate(16);
    await row.end();
    landFirst();
    await settle();
    await row.timeUpdate(31);
    expect(writes().at(-1)).toEqual({ itemId: BOOK.id, positionSeconds: 31, completed: false });
  });
});

describe('1 — the offline library keeps only audio its publisher names as audio', () => {
  const HREF = `/library/media/${BOOK.id}`;

  function browserCache(entries: Map<string, Response>, body: string, contentType: string) {
    const cache = {
      put: vi.fn(async (key: string, response: Response) => { entries.set(key, response); }),
      delete: vi.fn(async (key: string) => entries.delete(key)),
    };
    vi.stubGlobal('caches', { open: vi.fn(async () => cache), match: vi.fn(async (key: string) => entries.get(key)) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } })));
    return cache;
  }
  async function shown(item: Item): Promise<ReactNode> {
    render(h.hooks, createElement(ItemRow, { item }));
    for (let pass = 0; pass < 4; pass++) await settle();
    return render(h.hooks, createElement(ItemRow, { item }));
  }
  const NOT_STORED = 'Marked for offline, but not stored on this device yet.';

  it.each(['video/mp4', 'application/octet-stream'])('a %s file is not kept, and the person is told why', async (type) => {
    const cache = browserCache(new Map(), 'bytes', type);
    const tree = await shown(BOOK);
    await click(byName(tree, t('uiText.saveForOffline')));
    for (let pass = 0; pass < 4; pass++) await settle();

    expect(cache.put).not.toHaveBeenCalled();
    expect(h.toasts.error).toEqual([t('library.onlyAudioOffline')]);
    expect(progress.save.mock.calls.map(([input]) => input)).toEqual([
      { itemId: BOOK.id, offline: true }, { itemId: BOOK.id, offline: false },
    ]);
  });

  it('a named audio file is kept', async () => {
    const entries = new Map<string, Response>();
    const cache = browserCache(entries, 'audio-bytes', 'audio/mpeg');
    const tree = await shown(BOOK);
    await click(byName(tree, t('uiText.saveForOffline')));
    for (let pass = 0; pass < 4; pass++) await settle();

    expect(cache.put).toHaveBeenCalledWith(HREF, expect.any(Response));
    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual(['Saved for offline.']);
  });

  it('a video or unnamed file kept before is not shown as downloaded, and is removed', async () => {
    const entries = new Map([[HREF, new Response('old', { headers: { 'content-type': 'video/mp4' } })]]);
    const cache = browserCache(entries, 'unused', 'audio/mpeg');
    const tree = await shown({ ...BOOK, offline: true });
    expect(cache.delete).toHaveBeenCalledWith(HREF);
    expect(nodes(tree).some((n) => n.type === 'p' && n.props.children === NOT_STORED)).toBe(true);
  });

  it('audio kept before is still shown as downloaded', async () => {
    const entries = new Map([[HREF, new Response('old', { headers: { 'content-type': 'audio/mpeg' } })]]);
    const cache = browserCache(entries, 'unused', 'audio/mpeg');
    const tree = await shown({ ...BOOK, offline: true });
    expect(cache.delete).not.toHaveBeenCalled();
    expect(nodes(tree).some((n) => n.type === 'p' && n.props.children === NOT_STORED)).toBe(false);
  });
});
