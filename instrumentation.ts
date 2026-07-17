// instrumentation.ts — server-error observability + boot env guard (Next 15).
//
// Production Server-Component errors reach the client as an opaque `digest`;
// the real message only exists server-side. This hook logs every server render
// error WITH its digest to the function logs, so "digest 990847038 on the
// kiosk" can be grepped straight to the actual error + stack in Vercel logs —
// no more guessing what a digest means.

import { checkRequiredEnv } from '@/lib/health/status';

// Boot env guard: runs once when the Node server starts. If a Supabase core
// credential is missing/blank the whole app is dead-on-arrival, so we surface it
// as ONE loud, greppable startup line (`[boot] MISSING REQUIRED ENV: …`) instead
// of letting every request crash opaquely deep inside a handler. We only LOG
// (never throw) so a misconfigured preview/CI build still boots far enough to be
// diagnosed, and so this hook can never take down a deploy on its own. The live
// readiness signal is `GET /api/health` (503 when this is unhealthy).
export function register(): void {
  // register() also fires in the edge runtime; only run in Node, where the full
  // server env is present and these vars actually matter.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
  const env = checkRequiredEnv(process.env);
  if (!env.ok) {
    console.error(
      `[boot] MISSING REQUIRED ENV: ${env.missing.join(', ')} — the app cannot reach Supabase; ` +
        'requests will fail. Set these in the deployment environment. (see GET /api/health)',
    );
  }
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
