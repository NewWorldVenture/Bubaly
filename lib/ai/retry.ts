// lib/ai/retry.ts — bounded exponential backoff for READ-ONLY provider calls.
//
// WHY the read-only restriction is load-bearing: a retry re-sends the request,
// and an LLM request that carries tools can execute those tools again on the
// second attempt. The failure modes we retry on (429, 5xx, a dropped socket) are
// exactly the ones where the first attempt may well have reached OpenAI and had
// effects before the response was lost, so a blind retry of `runTools` /
// `runToolsStream` can double-create a calendar event or double-charge an
// allowance. Only wrap calls with no side effects: `complete()` without tools,
// `structuredCompletion()`, embeddings, classification. Write paths get their
// at-most-once guarantee from the `ai_tool_calls` idempotency ledger and the
// executor's per-step retry (§4.3), not from this module.
//
// The policy is deliberately small: 3 attempts, full-jitter exponential delay,
// and an immediate give-up on anything the provider will answer identically the
// second time (401, 402, 404, malformed request). The caller's AbortSignal wins
// at every point, including while sleeping, so a cancelled request stops paying
// for retries.

/** Attempt-level diagnostics handed to `onRetry` for logging. */
export type RetryInfo = { attempt: number; delayMs: number; error: unknown; status: number | null };

export type BackoffOptions = {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay; attempt n waits a random slice of base * 2^(n-1). Default 400ms. */
  baseDelayMs?: number;
  /** Ceiling on a single delay. Default 8000ms. */
  maxDelayMs?: number;
  /** Caller cancellation; checked before every attempt and during every sleep. */
  signal?: AbortSignal | null;
  /** Injectable randomness so tests get deterministic delays. */
  random?: () => number;
  /** Injectable sleep so tests do not spend real time. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Override which errors are worth retrying (defaults to isRetryableProviderError). */
  retryOn?: (error: unknown) => boolean;
  onRetry?: (info: RetryInfo) => void;
};

/** Thrown when the caller's signal aborts before or during an attempt. */
export class RetryAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('The request was cancelled before it completed.');
    this.name = 'AbortError';
  }
}

/**
 * Best-effort HTTP status for a provider error. `OpenAIProvider` throws
 * `Error('OpenAI error 429: …')` (see lib/ai/provider.ts), and fetch-layer
 * wrappers sometimes carry a numeric `status`, so both shapes are read.
 */
export function providerErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const raw = error as { status?: unknown; statusCode?: unknown };
    for (const candidate of [raw.status, raw.statusCode]) {
      if (typeof candidate === 'number' && candidate >= 100 && candidate < 600) return candidate;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /\berror\s+(\d{3})\b/i.exec(message) ?? /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (match) {
    const status = Number(match[1]);
    if (status >= 100 && status < 600) return status;
  }
  return null;
}

/**
 * True when re-sending the identical request has a real chance of succeeding:
 * rate limits, request timeouts, provider-side failures, and transport faults.
 *
 * Two explicit non-retries: a caller-initiated abort (`AbortError`) means the
 * work is no longer wanted, and `insufficient_quota` arrives as a 429 but is a
 * billing state that will not change in the next 800ms — retrying it just burns
 * the request budget and delays an honest error.
 */
export function isRetryableProviderError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (name === 'AbortError' || error instanceof RetryAbortedError) return false;
  if (/insufficient_quota|exceeded your current quota|billing/i.test(message)) return false;

  const status = providerErrorStatus(error);
  if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500;

  // No status: transport-level faults (including AbortSignal.timeout, which
  // surfaces as TimeoutError) are the retryable ones.
  if (name === 'TimeoutError') return true;
  return /timeout|etimedout|econnreset|econnrefused|enotfound|eai_again|fetch failed|network|socket hang up|stream (?:error|closed)/i.test(message);
}

function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RetryAbortedError(signal.reason)); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new RetryAbortedError(signal?.reason)); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full-jitter delay for attempt `attempt` (1-based), capped at maxDelayMs. */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter (AWS's recommendation): a uniform draw from [0, ceiling] spreads
  // a thundering herd of retrying crons far better than a fixed exponential step.
  return Math.max(0, Math.round(random() * ceiling));
}

/**
 * Run `fn` with bounded retries. `fn` receives the 1-based attempt number so it
 * can log or vary a request id. The last error is rethrown once the attempt cap
 * is reached, so callers keep the provider's real message.
 */
export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const retryOn = options.retryOn ?? isRetryableProviderError;
  const signal = options.signal ?? null;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new RetryAbortedError(signal.reason);
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new RetryAbortedError(signal.reason);
      if (attempt >= attempts || !retryOn(error)) throw error;
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      options.onRetry?.({ attempt, delayMs, error, status: providerErrorStatus(error) });
      console.error(`[ai-retry] attempt ${attempt}/${attempts} failed, retrying in ${delayMs}ms`, error);
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}
