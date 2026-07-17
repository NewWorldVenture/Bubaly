import { NextResponse } from 'next/server';
import { checkRequiredEnv, buildHealthReport } from '@/lib/health/status';
import { probeDatabase } from '@/lib/health/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated liveness + readiness endpoint for uptime monitors,
 * load-balancer health checks, and deploy smoke tests.
 *
 * Response body reports only booleans / latency / the NAMES of missing env vars —
 * never a secret value — so it is safe to expose without auth.
 *
 *   200 { status: "ok" }        — required env present AND Supabase reachable
 *   503 { status: "error" }     — a required env var is missing, or the DB is down
 *
 * The DB probe is bounded (3s abort) so a stalled database can never hang the
 * check itself. `dynamic = force-dynamic` prevents Next from statically caching a
 * stale "ok".
 */
export async function GET() {
  const env = checkRequiredEnv(process.env);
  const database = await probeDatabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const report = buildHealthReport(env, database);
  return NextResponse.json(report, {
    status: report.httpStatus,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
