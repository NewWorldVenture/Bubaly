import type { Page, Request, Response } from '@playwright/test';

const PHASES = ['upload-click-start', 'upload-click-complete', 'persistence-confirmed',
  'row-read-complete', 'body-complete', 'body-failed'] as const;
type Phase = typeof PHASES[number];
type Category = 'storage-upload' | 'photo-insert' | 'storage-compensation';
const TRACKING_LIMIT = 32;

function ignoreDiagnosticFailure(run: () => void): void { try { run(); } catch {} }
function statusNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function increment(value: number): number { return Math.min(value + 1, Number.MAX_SAFE_INTEGER); }

/** Only booleans, counts and a numeric status leave this boundary, never rows/errors. */
export function describePhotoRead(value: unknown) {
  const malformed = { valid: false, errorPresent: false, errorCodePresent: false, rowCount: null, status: null };
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed;
    const result = value as { data?: unknown; error?: unknown; status?: unknown };
    const errorPresent = result.error != null;
    const errorCodePresent = !!result.error && typeof result.error === 'object' && 'code' in result.error;
    const rowCount = Array.isArray(result.data) ? result.data.length : null;
    return { valid: !errorPresent && rowCount !== null, errorPresent, errorCodePresent, rowCount, status: statusNumber(result.status) };
  } catch { return malformed; }
}

/** An error accompanied by data must not satisfy the existing one-row assertion. */
export function familyPhotoRowCount(value: unknown): number | null {
  const result = describePhotoRead(value);
  return result.valid ? result.rowCount : null;
}

function requestCategory(request: Request, provider: string): Category | null {
  // The URL is inspected in memory solely for classification. No URL-derived label
  // or query, object name, family ID, body, headers or provider error is retained.
  const url = new URL(request.url());
  if (url.origin !== provider || url.username || url.password) return null;
  const method = request.method();
  if (method === 'POST' && url.pathname.startsWith('/storage/v1/object/family-media/')) return 'storage-upload';
  if (method === 'POST' && url.pathname === '/rest/v1/family_photos') return 'photo-insert';
  if (method === 'DELETE' && url.pathname === '/storage/v1/object/family-media') return 'storage-compensation';
  return null;
}

function requestCounts() { return { started: 0, finished: 0, failed: 0, responses: 0, lastStatus: null as number | null }; }

/** Passive, bounded observation only: no additional reads, retries or waits. */
export function observeFamilyPhotoUpload(
  page: Pick<Page, 'on' | 'off'>,
  provider: string,
  emit: (record: object) => void,
  clock: () => number = () => performance.now(),
) {
  let origin = '';
  ignoreDiagnosticFailure(() => { origin = new URL(provider).origin; });
  let startedAt: number | null = null;
  ignoreDiagnosticFailure(() => { const value = clock(); if (Number.isFinite(value)) startedAt = value; });
  let disposed = false;
  let outstanding = 0;
  let overflow = 0;
  let observationFailures = 0;
  const tracked = new WeakMap<Request, { category: Category; responded: boolean; ended: boolean }>();
  const requests = { 'storage-upload': requestCounts(), 'photo-insert': requestCounts(), 'storage-compensation': requestCounts() };
  const reads = { started: 0, completed: 0, rejected: 0, errorResults: 0, malformedResults: 0, empty: 0, one: 0, multiple: 0 };
  let lastRead: ReturnType<typeof describePhotoRead> | null = null;

  function observe(run: () => void) {
    if (disposed) return;
    try { run(); } catch { observationFailures = increment(observationFailures); }
  }
  const onRequest = (request: Request) => observe(() => {
    if (tracked.has(request)) return;
    const category = requestCategory(request, origin);
    if (category === null) return;
    if (outstanding >= TRACKING_LIMIT) { overflow = increment(overflow); return; }
    tracked.set(request, { category, responded: false, ended: false });
    outstanding++;
    requests[category].started = increment(requests[category].started);
  });
  const onResponse = (response: Response) => observe(() => {
    const entry = tracked.get(response.request());
    if (!entry || entry.responded || entry.ended) return;
    entry.responded = true;
    const counts = requests[entry.category];
    counts.responses = increment(counts.responses);
    counts.lastStatus = statusNumber(response.status());
  });
  function finish(request: Request, failed: boolean) {
    observe(() => {
      const entry = tracked.get(request);
      if (!entry || entry.ended) return;
      entry.ended = true;
      outstanding--;
      const counts = requests[entry.category];
      if (failed) counts.failed = increment(counts.failed);
      else counts.finished = increment(counts.finished);
    });
  }
  const onFinished = (request: Request) => finish(request, false);
  const onFailed = (request: Request) => finish(request, true);
  const remove = [
    () => page.off('request', onRequest), () => page.off('response', onResponse),
    () => page.off('requestfinished', onFinished), () => page.off('requestfailed', onFailed),
  ];
  observe(() => { page.on('request', onRequest); });
  observe(() => { page.on('response', onResponse); });
  observe(() => { page.on('requestfinished', onFinished); });
  observe(() => { page.on('requestfailed', onFailed); });

  return {
    report(phase: Phase): void {
      if (disposed || !PHASES.includes(phase)) return;
      ignoreDiagnosticFailure(() => {
        let elapsedMs: number | null = null;
        ignoreDiagnosticFailure(() => {
          const now = clock();
          if (startedAt !== null && Number.isFinite(now)) elapsedMs = Math.max(0, Math.round(now - startedAt));
        });
        emit({
          phase, elapsedMs, trackingLimit: TRACKING_LIMIT, outstanding, overflow, observationFailures,
          requests: {
            'storage-upload': { ...requests['storage-upload'] },
            'photo-insert': { ...requests['photo-insert'] },
            'storage-compensation': { ...requests['storage-compensation'] },
          },
          reads: { ...reads, pending: reads.started - reads.completed - reads.rejected },
          lastRead: lastRead && { ...lastRead },
        });
      });
    },
    async read<T>(operation: () => PromiseLike<T>): Promise<T> {
      observe(() => { reads.started = increment(reads.started); });
      try {
        const result = await operation();
        observe(() => {
          reads.completed = increment(reads.completed);
          lastRead = describePhotoRead(result);
          if (lastRead.errorPresent) reads.errorResults = increment(reads.errorResults);
          else if (!lastRead.valid) reads.malformedResults = increment(reads.malformedResults);
          else if (lastRead.rowCount === 0) reads.empty = increment(reads.empty);
          else if (lastRead.rowCount === 1) reads.one = increment(reads.one);
          else reads.multiple = increment(reads.multiple);
        });
        return result;
      } catch (error) {
        observe(() => { reads.rejected = increment(reads.rejected); });
        throw error;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of remove) ignoreDiagnosticFailure(off);
    },
  };
}
