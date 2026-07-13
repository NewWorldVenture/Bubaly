import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { needsDueReminder, needsOverdueAlert, daysUntilDue } from '@/lib/marketplace/returns';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Nudges families about borrowed/rented items coming due, and alerts both sides
// when one goes overdue. Each order gets at most one due-soon nudge and one
// overdue alert (dedupe stamps on the order). Best-effort notifications.
const BATCH = 200;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // Open rent/borrow orders with a due date; the partial index backs this.
  const { data: due, error } = await admin
    .from('marketplace_orders')
    .select('id, family_id, listing_id, buyer_member, kind, status, ends_on, due_reminder_sent_at, overdue_notified_at, returned_at')
    .in('kind', ['rent', 'borrow']).in('status', ['confirmed', 'active'])
    .not('ends_on', 'is', null)
    .limit(BATCH);
  if (error) return NextResponse.json({ ok: false, error: 'Could not load orders.' }, { status: 500 });

  // Titles for friendlier copy.
  const listingIds = [...new Set((due ?? []).map((o) => o.listing_id))];
  const { data: listings } = listingIds.length
    ? await admin.from('marketplace_listings').select('id, title').in('id', listingIds)
    : { data: [] };
  const titleOf = new Map((listings ?? []).map((l) => [l.id, l.title]));

  let reminded = 0, overdue = 0;
  for (const o of due ?? []) {
    const order = {
      kind: o.kind, status: o.status, endsOn: o.ends_on, returnedAt: o.returned_at,
      dueReminderSentAt: o.due_reminder_sent_at, overdueNotifiedAt: o.overdue_notified_at,
    };
    const title = titleOf.get(o.listing_id) ?? 'a borrowed item';
    const verb = o.kind === 'rent' ? 'rental' : 'borrowed item';

    if (needsOverdueAlert(order, now)) {
      const late = Math.abs(daysUntilDue(o.ends_on, now) ?? 0);
      await admin.from('notifications').insert({
        family_id: o.family_id, user_id: null, type: 'system',
        title: `Overdue: "${title}"`,
        body: `This ${verb} was due ${late} day${late === 1 ? '' : 's'} ago. Arrange the return so it doesn't hold anyone up.`,
        related_type: 'marketplace_orders', related_id: o.id,
      });
      await admin.from('marketplace_orders').update({ overdue_notified_at: nowIso }).eq('id', o.id);
      overdue++;
      continue; // don't also send a due-soon nudge for the same order
    }

    if (needsDueReminder(order, now)) {
      const d = daysUntilDue(o.ends_on, now) ?? 0;
      await admin.from('notifications').insert({
        family_id: o.family_id, user_id: null, type: 'system',
        title: `Due ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}: "${title}"`,
        body: `Time to return this ${verb}. Tap to see the exchange details.`,
        related_type: 'marketplace_orders', related_id: o.id,
      });
      await admin.from('marketplace_orders').update({ due_reminder_sent_at: nowIso }).eq('id', o.id);
      reminded++;
    }
  }

  return NextResponse.json({ ok: true, reminded, overdue });
}
