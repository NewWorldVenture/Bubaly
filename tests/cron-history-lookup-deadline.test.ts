import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCatchUpBoundary } from '../scripts/cron-run-history.mjs';

// One lookup owns 30 seconds, including every page and response body. These
// are synthetic fetches and native Response streams; no GitHub or cron route
// is contacted. The workflow must still have time for its fixed-window sweep.
const BUDGET_MS = 30_000;
const NOW = new Date('2026-10-16T12:00:00Z');
const TOKEN = 'synthetic-deadline-token';
const API = 'https://actions.invalid';
const RUN = {
  id: 123, event: 'schedule', conclusion: 'success',
  run_started_at: '2026-10-16T11:55:00Z', created_at: '2026-10-16T11:55:00Z',
};

function response(runs: object[] = [RUN], totalCount = runs.length, next?: string) {
  return new Response(JSON.stringify({ total_count: totalCount, workflow_runs: runs }), {
    headers: next ? { link: `<${next}>; rel="next"` } : undefined,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function lookup(fetchImpl: typeof fetch) {
  let result: Awaited<ReturnType<typeof discoverCatchUpBoundary>> | undefined;
  const task = discoverCatchUpBoundary({
    token: TOKEN, repo: 'example/repo', currentRunId: '999', fetchImpl, now: NOW, apiBaseUrl: API,
  }).then((value) => { result = value; return value; });
  return { task, result: () => result };
}

function expectDeadline(value: unknown) {
  expect(value).toMatchObject({ lookup: 'failed', since: '', source: 'failure' });
  expect(value).toHaveProperty('reason', expect.stringMatching(/30[,.]?000.*(?:ms|millisecond)|30 seconds/i));
  expect(JSON.stringify(value)).not.toContain(TOKEN);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one bounded cron history lookup', () => {
  it('aborts an outstanding fetch and returns failure by the overall deadline, even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => { signal = init?.signal; return pending.promise; };
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const atDeadline = run.result();
    const abortedAtDeadline = signal?.aborted;
    pending.resolve(response());
    await run.task;
    await vi.advanceTimersByTimeAsync(0);
    expectDeadline(atDeadline);
    expect(abortedAtDeadline).toBe(true);
    expect(run.result()).toEqual(atDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start another history query or consume a late response after the deadline', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const requested: string[] = [];
    let cancelled = false;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl: typeof fetch = async (url) => {
      requested.push(String(url));
      return requested.length === 1 ? pending.promise : response([]);
    };
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const atDeadline = run.result();
    pending.resolve(new Response(new ReadableStream({
      start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('{"total_count":0,"workflow_runs":[]}')); },
      cancel() { cancelled = true; },
    })));
    await vi.advanceTimersByTimeAsync(0);
    // Finish the old implementation's late read as well, preserving a finite
    // negative control without hiding any additional queries it starts.
    if (!cancelled) stream.close();
    await run.task;
    expectDeadline(atDeadline);
    expect(requested).toHaveLength(1);
    expect(cancelled).toBe(true);
    expect(run.result()).toEqual(atDeadline);
  });

  it('cancels a native response body whose headers arrived but whose JSON never completes', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; },
      cancel() { cancelled = true; },
    });
    const fetchImpl: typeof fetch = async (_url, init) => { signal = init?.signal; return new Response(body); };
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const atDeadline = run.result();
    const cancelledAtDeadline = cancelled;
    if (!cancelled) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify({ total_count: 1, workflow_runs: [RUN] })));
      stream.close();
    }
    await run.task;
    expectDeadline(atDeadline);
    expect(cancelledAtDeadline).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(run.result()).toEqual(atDeadline);
  });

  it('does not renew the budget when a body keeps trickling bytes', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; },
      cancel() { cancelled = true; },
    });
    const fetchImpl: typeof fetch = async () => new Response(body);
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    stream.enqueue(new TextEncoder().encode('{"total_count":1,'));
    await vi.advanceTimersByTimeAsync(14_999);
    stream.enqueue(new TextEncoder().encode('"workflow_runs":'));
    await vi.advanceTimersByTimeAsync(1);
    const atDeadline = run.result();
    if (!cancelled) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify([RUN]) + '}'));
      stream.close();
    }
    await run.task;
    expectDeadline(atDeadline);
    expect(cancelled).toBe(true);
    expect(run.result()).toEqual(atDeadline);
  });

  it('shares one budget across pagination and aborts the active page before later pages can start', async () => {
    vi.useFakeTimers();
    const requests: Array<{ url: URL; signal: AbortSignal | null | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, signal: init?.signal });
      await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
      if (url.searchParams.get('status') === 'success') return response([]);
      const page = Number(url.searchParams.get('page') ?? '1');
      if (url.searchParams.get('created')?.startsWith('<')) return response([]);
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return response([{ ...RUN, id: page, conclusion: 'failure' }], 3, page < 3 ? next.toString() : undefined);
    };
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const atDeadline = run.result();
    const activeAborted = requests.at(-1)?.signal?.aborted;
    // Let every hypothetical late page finish so the old implementation leaves
    // no pending test work. It must not use them to replace the timeout result.
    await vi.advanceTimersByTimeAsync(60_000);
    await run.task;
    expectDeadline(atDeadline);
    expect(requests).toHaveLength(3);
    expect(requests.map(({ url }) => url.searchParams.get('page'))).toEqual([null, null, '2']);
    expect(activeAborted).toBe(true);
    expect(requests.every(({ signal }) => signal === requests[0].signal)).toBe(true);
    expect(run.result()).toEqual(atDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a complete response before the deadline and clears the unused timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      signal = init?.signal;
      await new Promise<void>((resolve) => setTimeout(resolve, BUDGET_MS - 1));
      return response();
    };
    const run = lookup(fetchImpl);
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(await run.task).toEqual({ lookup: 'ok', since: RUN.run_started_at.replace('Z', '.000Z'), source: 'success' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(signal?.aborted).toBe(false);
  });

  it('preserves an early HTTP refusal and cancels the deadline without retrying', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      signal = init?.signal;
      return new Response(null, { status: 403 });
    };
    const result = await lookup(fetchImpl).task;
    expect(result).toEqual({ lookup: 'failed', since: '', source: 'failure', reason: 'Actions API returned HTTP 403.' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 2);
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(false);
  });
});
