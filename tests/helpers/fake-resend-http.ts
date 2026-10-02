// A synthetic Resend at the HTTP boundary, for route-level tests: it replaces
// global `fetch`, answers only POST https://api.resend.com/emails, and fails the
// test on any other URL. Nothing leaves the process.
//
// Key semantics follow Resend's documentation (re-checked 2026-09-30): the same
// key with the same body answers the original message; with a different body,
// 409 invalid_idempotent_request; a key is remembered for 24 h. A request with no
// key (the current route's sendEmail) is simply delivered.
export type FakeResendBehaviour =
  | 'accept'
  /** Accepted and delivered, but the answer is a 500: the sender cannot know. */
  | 'accept_then_500'
  /** The request never reaches the provider. */
  | 'lose_before_arrival'
  | 'reject_429';

const DAY_MS = 24 * 60 * 60 * 1000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createFakeResendHttp(now: () => number = () => Date.now()) {
  const keys = new Map<string, { body: string; id: string; storedAt: number }>();
  const inbox: { to: string; key: string | null; body: string; id: string }[] = [];
  const requests: { to: string; key: string | null; body: string }[] = [];
  const stray: string[] = [];
  let script: (req: { to: string; n: number }) => FakeResendBehaviour = () => 'accept';

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://api.resend.com/emails' || init.method !== 'POST') {
      stray.push(url);
      throw new Error(`fake Resend: unexpected outbound request to ${url}`);
    }
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const key = new Headers(init.headers).get('idempotency-key');
    const body = String(init.body);
    const to = String((JSON.parse(body) as { to?: unknown }).to);
    const n = requests.filter((r) => r.to === to).length + 1;
    requests.push({ to, key, body });
    const behaviour = script({ to, n });
    if (behaviour === 'lose_before_arrival') throw new TypeError('fetch failed');
    if (behaviour === 'reject_429') return json(429, { name: 'rate_limit_exceeded', message: 'synthetic' });
    const t = now();
    const known = key ? keys.get(key) : undefined;
    if (key && known && t - known.storedAt >= DAY_MS) keys.delete(key);
    const live = key ? keys.get(key) : undefined;
    if (live) return live.body === body ? json(200, { id: live.id }) : json(409, { name: 'invalid_idempotent_request', message: 'synthetic' });
    const id = `msg-${inbox.length + 1}`;
    if (key) keys.set(key, { body, id, storedAt: t });
    inbox.push({ to, key, body, id });
    return behaviour === 'accept_then_500' ? json(500, { name: 'internal_server_error' }) : json(200, { id });
  };

  return {
    fetchImpl,
    inbox,
    requests,
    stray,
    /** Test-only: a key already used for other bytes (by a sender this engine replaces). */
    preuse(key: string, body: string) { keys.set(key, { body, id: `msg-foreign-${keys.size + 1}`, storedAt: now() }); },
    set script(fn: (req: { to: string; n: number }) => FakeResendBehaviour) { script = fn; },
    deliveredTo: (to: string) => inbox.filter((m) => m.to === to).length,
  };
}
