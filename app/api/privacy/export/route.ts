import { NextResponse } from 'next/server';
import { getUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { aal2Verdict } from '@/lib/auth/require-aal2';
import { ledgerWriter } from '@/lib/trust/ledger';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { buildFamilyExport, exportFilename, serializeExport } from '@/lib/privacy/export';
import type { Json } from '@/lib/database.types';

// Privacy Center › "Export my family's data".
//
// The file is built under the caller's own ServiceScope (role rules + RLS,
// see lib/privacy/export.ts) and streamed back as a JSON attachment: nothing
// is written to a bucket, so there is no second copy to secure or expire.
//
// Every download is a row in `trust_audit_logs` (domain `privacy`, capability
// `export`) — the ledger the Privacy Center's "Recent exports" and "Who
// accessed what" lists read from. The row is written BEFORE the bytes go out,
// and an export whose record cannot be written is refused: a data export that
// leaves no trace is exactly the event an access log exists to show.
//
// Order of refusals: not signed in (401) → no family yet (403) → too many
// exports (429) → step-up needed (403, with where to go) → a section could
// not be read (502, retryable) → the ledger would not take the row (500).
export const dynamic = 'force-dynamic';

const RETURN_TO = '/dashboard/settings#privacy';

export async function GET() {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if ('needsFamily' in ctx) return NextResponse.json({ error: 'no_family' }, { status: 403 });

  const supabase = await createServer();

  // Building the file reads a dozen tables; five a minute per person is plenty
  // for a human and a wall for a script.
  const limited = await enforceRequestRateLimit(supabase, `privacy-export:${ctx.user.id}`, { limit: 5 });
  if (!limited.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } });
  }

  // A manager with an authenticator proves it before a whole-family download,
  // the same as before opening the finances.
  const verdict = await aal2Verdict(ctx, 'documents', RETURN_TO);
  if (verdict.action === 'step_up') {
    return NextResponse.json({ error: 'step_up_required', stepUp: verdict.to }, { status: 403 });
  }

  const scope = scopeFromUserContext(ctx, supabase);
  const built = await buildFamilyExport(scope);
  if (!built.ok) {
    return NextResponse.json(
      { error: 'export_failed', failed: built.failed.map((f) => f.key), retryable: true },
      { status: 502 },
    );
  }

  const exportData = built.data;
  const sectionCounts = Object.fromEntries(exportData.sections.map((s) => [s.key, s.count]));
  const writer = await ledgerWriter(supabase);
  const { error: ledgerError } = await writer.from('trust_audit_logs').insert({
    family_id: ctx.active.familyId,
    actor_kind: 'member',
    actor_id: ctx.active.member.id,
    domain: 'privacy',
    capability: 'export',
    decision: 'executed',
    reason: `Family data export downloaded (${exportData.sections.length} sections)`,
    context: {
      kind: 'privacy_export',
      format: exportData.format,
      version: exportData.version,
      role: ctx.active.role,
      sections: sectionCounts,
      withheld: exportData.withheld,
      truncated: exportData.sections.filter((s) => s.truncated).map((s) => s.key),
    } as Json,
  });
  if (ledgerError) {
    console.error('[privacy] export ledger write failed', ledgerError);
    return NextResponse.json({ error: 'audit_failed', retryable: true }, { status: 500 });
  }

  return new Response(serializeExport(exportData), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(exportData.family.name, exportData.exportedAt)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
