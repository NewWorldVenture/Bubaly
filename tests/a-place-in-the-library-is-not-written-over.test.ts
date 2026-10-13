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
afterEach(() => vi.restoreAllMocks());

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
