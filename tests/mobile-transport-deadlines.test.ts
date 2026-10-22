// Every phone-to-server call has a deadline (N17), and says so in its own words.
//
// None of the phone's transports bounded a request: the assistant and the
// transcriber aborted only on Stop or a context change, the calendar read only
// on a key change or unmount, and the PostgREST reads behind useAsyncData
// carried no signal at all. Android's fetch runs on an OkHttp client built
// with no read or write timeout, so a half-open socket showed "Thinking…" with
// no end, Today's '–' stats, or the Chores and Grocery tabs' blank initial
// state until the person guessed to stop, pull or navigate. The server bounds
// its own provider calls at 60 s, so the gap was the transport. Each call now
// links its caller's signal with a timer — 75 s for the two AI routes so the
// server's own answer arrives first, 20 s for a read — and a timeout is shown as
// "taking longer than expected", not as the network copy or nothing.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_DEADLINE_MS, READ_DEADLINE_MS, withDeadline } from '../mobile/src/lib/deadline';
import { mobileTranslate } from '../mobile/src/lib/mobile-i18n';

const h = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn() }));
vi.mock('../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: h.session } } }));
vi.mock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://example.invalid' } }));
// Web CI has no native dependencies. Keep native imports dynamic so the web
// typecheck does not absorb the separate mobile TS project; mobile CI checks it.
const queriesModule = '../mobile/src/lib/queries';
const apiModule = '../mobile/src/lib/api';
const { fetchUpcomingEvents, fetchOpenChores, fetchGroceryList } = await import(queriesModule);
const { askAssistant, transcribeSpeech } = await import(apiModule);

const owner = { userId: 'user', familyId: 'family', memberId: 'member', timezone: 'America/Los_Angeles' };
const timedOut = mobileTranslate('en-US', 'mobileAssistant.timedOut');
const network = mobileTranslate('en-US', 'mobileAssistant.network');
/** A fetch that answers only when its signal is aborted, as a stalled socket does. */
const stalled = () => h.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
}));

beforeEach(() => {
  h.session.mockReset().mockResolvedValue({ data: { session: { user: { id: 'user' }, access_token: 'fresh-token' } }, error: null });
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  it('follows the caller’s signal and fires on its own after the deadline', () => {
    const caller = new AbortController();
    const linked = withDeadline(caller.signal, 1_000);
    expect(linked.signal.aborted).toBe(false);
    caller.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false);
    const timed = withDeadline(undefined, 1_000);
    vi.advanceTimersByTime(999); expect(timed.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(timed.signal.aborted).toBe(true); expect(timed.timedOut()).toBe(true);
    const cleared = withDeadline(undefined, 1_000); cleared.clear();
    vi.advanceTimersByTime(5_000); expect(cleared.signal.aborted).toBe(false);
    expect(ASSISTANT_DEADLINE_MS).toBe(75_000);
    expect(READ_DEADLINE_MS).toBe(20_000);
  });
});

describe('every transport gives up on a stalled socket', () => {
  beforeEach(() => vi.useFakeTimers());

  it('the assistant turn settles as "taking longer than expected" after 75 s with nobody tapping Stop', async () => {
    stalled();
    const pending = askAssistant({ token: 'token', conversationId: 'conversation-1', message: 'hello', locale: 'en-US' });
    const settled = pending.then(() => 'resolved', (error: Error & { code?: string }) => error);
    const init = h.fetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(ASSISTANT_DEADLINE_MS - 1);
    expect(init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(init.signal!.aborted).toBe(true);
    expect(await settled).toMatchObject({ code: 'timeout', message: timedOut });
  });

  it('a transcription does the same, a refused connection is still the network copy, and the caller’s own Stop still wins', async () => {
    stalled();
    const stop = new AbortController();
    const pending = transcribeSpeech({ token: 'token', recording: { uri: 'file:///voice.m4a' }, locale: 'en-US', signal: stop.signal });
    const settled = pending.then(() => 'resolved', (error: Error) => error);
    await vi.advanceTimersByTimeAsync(ASSISTANT_DEADLINE_MS);
    expect(await settled).toMatchObject({ code: 'timeout', message: timedOut });
    h.fetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(transcribeSpeech({ token: 'token', recording: { uri: 'file:///voice.m4a' }, locale: 'en-US' })).rejects.toMatchObject({ code: 'network', message: network });
    stalled();
    const stopped = transcribeSpeech({ token: 'token', recording: { uri: 'file:///voice.m4a' }, locale: 'en-US', signal: stop.signal }).then(() => 'resolved', (error: Error) => error);
    stop.abort();
    expect(await stopped).toMatchObject({ name: 'AbortError' });
  });

  it('the calendar read gives up after 20 s and says it is taking longer than expected', async () => {
    stalled();
    const settled = fetchUpcomingEvents(owner).then(() => 'resolved', (error: Error) => error);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await settled).toMatchObject({ code: 'timeout', message: timedOut });
    expect((h.fetch.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  });

  it('the calendar read shows a refused connection and an unreadable session as the network copy, never React Native’s or auth-js’s wording', async () => {
    h.fetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(fetchUpcomingEvents(owner)).rejects.toMatchObject({ code: 'network', message: network });
    h.session.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Session refresh temporarily unavailable.' } });
    await expect(fetchUpcomingEvents(owner)).rejects.toMatchObject({ message: network });
  });
});

describe('the PostgREST reads carry the caller’s signal', () => {
  /** A client that records the signal each query was given. */
  const recording = () => {
    const signals: (AbortSignal | undefined)[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) chain[m] = () => chain;
    chain.abortSignal = (signal: AbortSignal) => { signals.push(signal); return chain; };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
    return { db: { from: () => chain }, signals };
  };

  it('fetchOpenChores and fetchGroceryList pass the signal to every read they make', async () => {
    const signal = new AbortController().signal;
    const chores = recording();
    await fetchOpenChores(chores.db, 'family', signal);
    expect(chores.signals).toEqual([signal, signal]);
    const grocery = recording();
    await fetchGroceryList(grocery.db, 'family', signal);
    expect(grocery.signals).toEqual([signal]);
  });
});

describe('useAsyncData bounds its loader', () => {
  const requireMobile = createRequire(new URL('../mobile/package.json', import.meta.url));
  const resolveNative = (name: string) => { try { return requireMobile.resolve(name); } catch { return name; } };
  const slots: unknown[] = []; let cursor = 0; let effects: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    slots.length = 0; cursor = 0; effects = [];
    vi.doMock(resolveNative('react'), async () => ({
      ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
      useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
      useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useCallback: (fn: unknown, deps: unknown[]) => { const i = cursor++; const old = slots[i] as { fn: unknown; deps: unknown[] } | undefined; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { fn, deps }; return (slots[i] as { fn: unknown }).fn; },
      useEffect: (effect: () => void, deps: unknown[]) => { const i = cursor++; const old = slots[i] as unknown[] | undefined; if (!old || deps.some((v, n) => v !== old[n])) { slots[i] = deps; effects.push(effect); } },
    }));
  });

  it('aborts the loader’s signal after 20 s and settles as "taking longer than expected"', async () => {
    const hookModule = '../mobile/src/hooks/use-async-data';
    const { useAsyncData } = await import(hookModule) as { useAsyncData: <T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]) => { data: T | null; error: string | null; loading: boolean } };
    let seen: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => { seen = signal; signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); }));
    // A component that is nothing but the hook, rendered by hand with the shim above.
    function Probe() { cursor = 0; return useAsyncData(loader, ['family']); }
    Probe(); effects.splice(0).forEach((effect) => effect());
    expect(Probe().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1);
    expect(seen?.aborted).toBe(false);
    expect(Probe().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);
    const state = Probe();
    expect(state.loading).toBe(false);
    expect(state.error).toBe(timedOut);
    expect(state.data).toBeNull();
  });
});
