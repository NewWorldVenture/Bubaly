import { NextRequest, NextResponse } from 'next/server';
import { checkRequiredEnv, checkFeatureEnv, buildHealthReport, publicHealthBody } from '@/lib/health/status';
import { probeDatabase, probeAuth, probeServiceRole } from '@/lib/health/probe';
import { bearerMatches } from '@/lib/server/secret-compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated liveness + readiness endpoint for uptime monitors,
 * load-balancer health checks, and deploy smoke tests.
 *
 * The public body carries the status, the time and one boolean per check —
 * nothing else. It used to carry the whole report: the NAMES of every unset
 * feature secret, whether the service-role credential is accepted, and the
 * upstream probes' error text. No secret value, ever — but a configuration
 * description any anonymous caller could read and a scanner could keep. That
 * detail now goes to the server log, and to a monitor that presents
 * `Authorization: Bearer <HEALTH_MONITOR_SECRET>` (compared in constant time;
 * unset means nobody gets it). Choosing and distributing that value is an
 * operator action. Audit N5.
 *
 *   200 { status: "ok" }        — required env present, PostgREST AND auth reachable
 *   200 { status: "degraded" }  — env + data healthy, but either the auth service
 *                                 (GoTrue) is down (LB-001 shape), the service-role
 *                                 key is present-but-rejected, or a feature secret is
 *                                 unset; NOT 503 on purpose, so neither a
 *                                 shared-upstream auth outage nor an admin-only
 *                                 credential fault yanks the fleet
 *   503 { status: "error" }     — a required env var is missing, or PostgREST is down
 *
 * All three probes are bounded (3s abort) and run in parallel so a stalled dependency
 * can never hang the check. `dynamic = force-dynamic` prevents Next from statically
 * caching a stale result.
 */
export async function GET(req: NextRequest) {
  const env = checkRequiredEnv(process.env);
  const features = checkFeatureEnv(process.env);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const [database, auth, serviceRole] = await Promise.all([
    probeDatabase(url, anonKey),
    probeAuth(url, anonKey),
    probeServiceRole(url, process.env.SUPABASE_SERVICE_ROLE_KEY),
  ]);
  const report = buildHealthReport(env, database, auth, new Date(), serviceRole, features);
  // The detail is for the operator: which checks failed and why, in the log.
  const failing = Object.fromEntries(Object.entries(report.checks).filter(([, check]) => !check.ok));
  if (Object.keys(failing).length > 0) console.warn('[health] failing checks', failing);
  const detailed = bearerMatches(req.headers.get('authorization'), process.env.HEALTH_MONITOR_SECRET);
  return NextResponse.json(detailed ? report : publicHealthBody(report), {
    status: report.httpStatus,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
