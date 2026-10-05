import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Real useVoice async playback logic with a minimal hook host. Requests and the
// audio device are held boundaries: no provider calls or microphone permission.
const slots: unknown[] = [];
let cursor = 0;
let cleanups: Array<() => void> = [];
vi.mock('react', () => ({
  useRef: (initial: unknown) => { const index = cursor++; return slots[index] ??= { current: initial }; },
  useState: (initial: unknown) => {
    const index = cursor++; slots[index] ??= initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
}));
import { useVoice } from '@/lib/hooks/use-voice';

const synth = { cancel: vi.fn(), speak: vi.fn() };
const play = vi.fn(async () => {});
const audio = vi.fn(function () { return { play, pause: vi.fn(), src: '', onended: null, onerror: null }; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  slots.length = 0; cursor = 0; cleanups = [];
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('Audio', audio);
  vi.stubGlobal('SpeechSynthesisUtterance', class { onend = null; constructor(public text: string) {} });
  synth.cancel.mockClear(); synth.speak.mockClear(); audio.mockClear(); play.mockClear();
});
afterEach(() => { cleanups.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

it.each(['stop', 'unmount'])('never plays a response whose pending speech request was retired by %s', async (kind) => {
  const response = deferred<Response>(); const fetchMock = vi.fn(() => response.promise); vi.stubGlobal('fetch', fetchMock);
  const voice = useVoice(); const pending = voice.speak('Private response from household A');
  const signal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  if (kind === 'stop') voice.stopSpeaking(); else cleanups.forEach(cleanup => cleanup());
  expect(signal.aborted).toBe(true);
  response.resolve(new Response(new Uint8Array([1, 2, 3]))); await pending;
  expect(audio).not.toHaveBeenCalled(); expect(synth.speak).not.toHaveBeenCalled();
});

it('does not fall back to browser speech when an old failed request completes after a newer request', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const voice = useVoice(); const old = voice.speak('Old private words'); const next = voice.speak('Current words');
  first.resolve(new Response('', { status: 503 })); await old;
  expect(synth.speak).not.toHaveBeenCalled();
  second.resolve(new Response('', { status: 503 })); await next;
  expect(synth.speak).toHaveBeenCalledOnce();
  expect(synth.speak.mock.calls[0][0].text).toBe('Current words');
});

it('retires speech even when response headers arrived before stopping but the audio body is delayed', async () => {
  const body = deferred<ArrayBuffer>();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: () => body.promise })));
  const voice = useVoice(); const pending = voice.speak('Late audio'); await Promise.resolve();
  voice.stopSpeaking(); body.resolve(new ArrayBuffer(2)); await pending;
  expect(audio).not.toHaveBeenCalled(); expect(synth.speak).not.toHaveBeenCalled();
});
