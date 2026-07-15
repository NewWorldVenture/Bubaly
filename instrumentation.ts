// instrumentation.ts — server-error observability (Next 15).
//
// Production Server-Component errors reach the client as an opaque `digest`;
// the real message only exists server-side. This hook logs every server render
// error WITH its digest to the function logs, so "digest 990847038 on the
// kiosk" can be grepped straight to the actual error + stack in Vercel logs —
// no more guessing what a digest means.

export function register(): void {
  /* no runtime setup needed */
}

export function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): void {
  const e = err as { message?: string; stack?: string; digest?: string };
  console.error(
    `[server-error] digest=${e?.digest ?? 'none'} route=${context.routePath} (${request.method} ${request.path}, ${context.routeType})`,
    e?.message,
    e?.stack?.split('\n').slice(0, 8).join('\n'),
  );
}
