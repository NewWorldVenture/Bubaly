// Transport failures must degrade like query failures, not take the page down.
//
// A Supabase query builder RESOLVES with { data, error } for anything the
// database actually answers — including every error it reports. It REJECTS only
// when the request never completed: DNS, TCP, TLS, an aborted or timed-out
// fetch. Those are exactly the failures an overloaded or unreachable database
// produces, and they are invisible to the `if (res.error)` checks a page is
// built around.
//
// Inside `Promise.all` that difference is the whole problem. One rejection
// rejects the batch, so a page that carefully logs res.error for all twenty of
// its reads still dies on an unhandled rejection and renders the error boundary
// — "This page hit a snag" — instead of the degraded view it was designed to
// show. That is what took out /dashboard while the production database was
// reporting CONNECT_TIMEOUT.
//
// `settleAll` keeps the tuple shape and the destructuring exactly as they were,
// and substitutes { data: null, count: null, error } for anything that rejected.
// The caller's existing error handling then runs for transport failures too.
//
// This is deliberately NOT a retry and NOT a cache. It only ensures that a
// failure the page already knows how to survive is delivered in the shape the
// page expects.

/** What a rejected query becomes: the shape every caller already handles. */
export type SettledFallback = { data: null; count: null; error: { message: string } };

function toFallback(cause: unknown): SettledFallback {
  return {
    data: null,
    count: null,
    error: { message: cause instanceof Error ? cause.message : String(cause) },
  };
}

/** Resolve one query, turning a transport rejection into { data: null, error }. */
export function settle<T>(query: PromiseLike<T>): Promise<T | SettledFallback> {
  return Promise.resolve(query).then((value) => value, toFallback);
}

/**
 * `Promise.all` for Supabase reads: never rejects, so one unreachable table
 * cannot cost the caller every other result it already has in hand.
 */
export function settleAll<T extends readonly PromiseLike<unknown>[] | []>(
  queries: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> | SettledFallback }> {
  return Promise.all(queries.map((query) => settle(query))) as Promise<{
    -readonly [K in keyof T]: Awaited<T[K]> | SettledFallback;
  }>;
}
