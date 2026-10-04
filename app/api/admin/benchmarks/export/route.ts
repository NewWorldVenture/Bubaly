import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/server/audit';
import { readBenchmarkAggregates } from '@/lib/network/benchmarks-server';
import { benchmarksCsv } from '@/lib/network/benchmarks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// CSV export of the published household benchmarks, for content and research.
// Same gate as the admin console (super-admin, re-verified here because a
// route handler is not protected by the /admin layout), same service-role
// read, same rows: k-anonymized, DP-noised, no per-family data anywhere.
export async function GET() {
  const t = await getTranslations();
  const user = await getUser();
  if (!user) return NextResponse.json({ error: t('benchmarksExport.signInRequired') }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  if (!(await isSuperAdmin())) return NextResponse.json({ error: t('benchmarksExport.notAuthorized') }, { status: 403, headers: { 'Cache-Control': 'no-store' } });

  const supabase = createServiceClient();
  const read = await readBenchmarkAggregates(supabase);
  if (!read.ok) return NextResponse.json({ error: t('benchmarksExport.readFailed') }, { status: 502, headers: { 'Cache-Control': 'no-store' } });

  const computedAt = read.computedAt ?? '';
  const csv = benchmarksCsv(read.aggregates, computedAt);
  // Aggregates, not personal data, but the audit row is still the only record
  // of who exported them and when, and nothing has been sent yet when it is
  // refused: a lost row is a 500 the operator can retry, not a file under a 200
  // with a console line (DATA-009, API-972FC3BFEB60).
  const audit = await recordAudit(supabase, {
    familyId: null, actorId: user.id, action: 'export', resource: 'household_benchmarks',
    metadata: { rows: read.aggregates.length, via: 'site_admin' },
  });
  if (!audit.ok) {
    console.error('[benchmarks] export audit row was not written; nothing sent', audit.error);
    return NextResponse.json({ error: 'audit_failed', retryable: true }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="household-benchmarks-${day}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
