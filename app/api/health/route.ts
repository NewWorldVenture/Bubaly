import { NextResponse } from 'next/server';
import { checkRequiredEnv, buildHealthReport } from '@/lib/health/status';
import { probeDatabase, probeAuth } from '@/lib/health/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated liveness + readiness endpoint for uptime monitors,
 * load-balancer health checks, and deploy smoke tests.
 *
 * Response body reports only booleans / latency / the NAMES of missing env vars —
 * never a secret value — so it is safe to expose without auth.
 *
 *   200 { status: "ok" }        — required env present, PostgREST AND auth reachable
 *   200 { status: "degraded" }  — env + data healthy, but the auth service (GoTrue)
 *                                 is down (LB-001 shape); NOT 503 on purpose so a
 *                                 shared-upstream auth outage doesn't yank the fleet
 *   503 { status: "error" }     — a required env var is missing, or PostgREST is down
 *
 * Both probes are bounded (3s abort) and run in parallel so a stalled dependency
 * can never hang the check. `dynamic = force-dynamic` prevents Next from statically
 * caching a stale result.
 */
export async function GET() {
  const env = checkRequiredEnv(process.env);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const [database, auth] = await Promise.all([
    probeDatabase(url, anonKey),
    probeAuth(url, anonKey),
  ]);
  const report = buildHealthReport(env, database, auth);
  return NextResponse.json(report, {
    status: report.httpStatus,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
