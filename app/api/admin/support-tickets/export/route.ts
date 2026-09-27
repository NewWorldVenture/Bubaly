import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { readAll } from '@/lib/supabase/read-all';
import { TICKET_CSV_COLUMNS, ticketsCsv } from '@/lib/admin/tickets-csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Export button on /admin/support-tickets had no handler. Same gate as the
// page's actions (super-admin, re-checked: a route handler is not behind the
// /admin layout), same service-role read. A failed read is a 502, never an
// empty file that looks like "no tickets". Audit C1-S9-105.
export async function GET() {
  const t = await getTranslations();
  const noStore = { 'Cache-Control': 'no-store' };
  const user = await getUser();
  if (!user) return NextResponse.json({ error: t('benchmarksExport.signInRequired') }, { status: 401, headers: noStore });
  if (!(await isSuperAdmin())) return NextResponse.json({ error: t('benchmarksExport.notAuthorized') }, { status: 403, headers: noStore });

  const supabase = createServiceClient();
  // Every ticket, paged. A capped read would hand back a file that looks
  // complete and is not.
  const { rows: data, error } = await readAll((from, to) => supabase
    .from('support_tickets')
    .select(TICKET_CSV_COLUMNS.join(', '))
    .order('updated_at', { ascending: false })
    .order('id')
    .range(from, to));
  if (error) {
    console.error('[admin-support-tickets] export read failed', error);
    return NextResponse.json({ error: t('supportTickets.couldNotLoadSupportTickets') }, { status: 502, headers: noStore });
  }

  await logAudit(supabase, {
    familyId: null, actorId: user.id, action: 'export', resource: 'support_tickets',
    metadata: { rows: data.length, via: 'site_admin' },
  });
  // The instant, not a server-clock "day": which day it is depends on where
  // the operator is.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new NextResponse(ticketsCsv(data as unknown as Record<string, unknown>[]), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="support-tickets-${stamp}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
