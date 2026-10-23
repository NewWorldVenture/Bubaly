import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAll } from '@/lib/supabase/read-all';
import { needsDueReminder, needsOverdueAlert, daysUntilDue } from '@/lib/marketplace/returns';
import { deliveryTimeFor, notify } from '@/lib/services/notifications';
import { dayKeyInTz, systemScopeForFamily } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';
import { readInChunks } from '@/lib/supabase/chunked-in';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Nudges families about borrowed/rented items coming due, and alerts both sides
// when one goes overdue. Each order gets at most one due-soon nudge and one
// overdue alert (dedupe stamps on the order). Best-effort notifications.
//
// The read below is PAGED rather than capped at a batch, because which orders
// need a nudge is decided in code and not by the query: nothing filters on
// `ends_on`, so a plain `.limit(200)` filled itself with open borrows due
// months from now and stopped. PostgREST orders a query with no ORDER BY
// arbitrarily, so an item due today could fall outside that slice on every run
// and never be nudged, while the run answered 200. See lib/supabase/read-all.ts
// for why `.limit()` is not a bound either.
const MAX_OPEN_ORDERS = 5000;

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('returnReminders.unauthorized') }, { status: 401 });
  }

  try {
    const admin = createServiceClient();

    // One scope per family, built once. Overdue nudges are a courtesy, not an
    // emergency — they go through the service so they land inside the hours a
    // household agreed to hear from Bubaly, and so a re-run of the cron cannot
    // send the same nudge twice before anyone has read the first.
    const scopes = new Map<string, ServiceScope | null>();
    // Resolved BEFORE the due-date decision, not just before the send, because
    // the scope is where the family's timezone lives and "is this due today"
    // cannot be answered without it. This job is cross-family — one query, no
    // family filter — so a single host day was deciding for every household at
    // once, and the dedupe stamps are one-shot: a nudge sent against the wrong
    // day is not early, it is the only nudge that order will ever get.
    const scopeFor = async (familyId: string): Promise<ServiceScope | null> => {
      if (!scopes.has(familyId)) scopes.set(familyId, await systemScopeForFamily(admin, familyId));
      return scopes.get(familyId) ?? null;
    };
    const notifyFamily = async (
      familyId: string,
      n: { title: string; body: string; relatedType: string; relatedId: string | null; once?: boolean },
    ): Promise<boolean> => {
      const scope = await scopeFor(familyId);
      if (!scope) return false;
      const sent = await notify(scope, { recipients: 'family', type: 'system', ...n });
      // Delivered means a row exists for THIS identity: written now, or already
      // there from a run that sent and then failed to stamp. `sent.ok` alone
      // was true with `created: 0` when notify() filtered every recipient as
      // already notified about something else under the same identity — and
      // when nobody could be resolved at all — and that stamped the order as
      // alerted when nobody was.
      return sent.ok && (sent.data.created > 0 || sent.data.duplicates > 0);
    };
    const now = new Date();
    const nowIso = now.toISOString();
    // The day the family will READ the notice, which is not always the day this
    // run sends it. notify() holds a courtesy notice past the family's quiet
    // hours, and a window that crosses midnight holds the 08:00 UTC tick (21:00
    // in Auckland, 22:00 the evening before in Honolulu) until the next local
    // morning. Worded from the tick's own day, "Due today" arrived the morning
    // after the item was due and "Due in 1 day" on the day itself. The words are
    // the reading day's, from the same deliveryTimeFor() notify() stamps the row
    // with; WHETHER to send is still decided on the family's day at the tick
    // (todayKey), so neither one-shot stamp is spent ahead of its day. One
    // answer per family.
    const readDays = new Map<string, string>();
    const readDayFor = async (scope: ServiceScope): Promise<string> => {
      const known = readDays.get(scope.familyId);
      if (known !== undefined) return known;
      const { sendAt } = await deliveryTimeFor(scope);
      const day = dayKeyInTz(new Date(sendAt), scope.tz);
      readDays.set(scope.familyId, day);
      return day;
    };
    // An overdue notice, worded for the day it is read on.
    const overdueWords = (title: string, verb: string, late: number) => ({
      title: `Overdue: "${title}"`,
      body: `This ${verb} was due ${late} day${late === 1 ? '' : 's'} ago. Arrange the return so it doesn't hold anyone up.`,
    });
    // The dedupe stamp is a CLAIM taken before the send, not a receipt written
    // after it: fenced on the column being unset, so of two overlapping runs
    // only one sends, and handed back if the send did not go out, so the next
    // run tries again rather than finding the order stamped and nobody told.
    type StampColumn = 'due_reminder_sent_at' | 'overdue_notified_at';
    const stampPatch = (column: StampColumn, value: string | null): Partial<Record<StampColumn, string | null>> => ({ [column]: value });
    const claimStamp = async (column: StampColumn, orderId: string): Promise<'claimed' | 'taken' | 'error'> => {
      const { data: claimed, error } = await admin.from('marketplace_orders')
        .update(stampPatch(column, nowIso)).eq('id', orderId).is(column, null).select('id');
      if (error) {
        console.error(`Return-reminders ${column} claim failed for ${orderId}:`, error);
        return 'error';
      }
      return claimed?.length ? 'claimed' : 'taken';
    };
    const restoreStamp = async (column: StampColumn, orderId: string): Promise<void> => {
      const { data: restored, error } = await admin.from('marketplace_orders')
        .update(stampPatch(column, null)).eq('id', orderId).eq(column, nowIso).select('id');
      if (error || !restored?.length) {
        console.error(`Return-reminders ${column} could not be handed back for ${orderId}:`, error ?? 'no rows updated');
      }
    };

    // Open rent/borrow orders with a due date; the partial index backs this,
    // and soonest-due first means the most urgent order is served first even if
    // the ceiling is ever reached. `id` breaks ties so a page boundary between
    // two orders sharing a due date cannot skip or repeat one.
    const { rows: due, error } = await readAll((from, to) => admin
      .from('marketplace_orders')
      .select('id, family_id, listing_id, buyer_member, kind, status, ends_on, due_reminder_sent_at, overdue_notified_at, returned_at')
      .in('kind', ['rent', 'borrow']).in('status', ['confirmed', 'active'])
      .not('ends_on', 'is', null)
      .order('ends_on', { ascending: true })
      .order('id')
      .range(from, to), { max: MAX_OPEN_ORDERS });
    // readAll reports the ceiling as an error rather than returning a prefix, so
    // an unserved tail fails the run instead of reading as a clean one.
    if (error) {
      console.error('Return-reminders order read failed:', error);
      return NextResponse.json({ ok: false, error: t('returnReminders.couldNotLoadOrders') }, { status: 500 });
    }

    // Titles for friendlier copy. A failed lookup is a failed batch because the
    // job must not acknowledge a partial notification run as healthy.
    const listingIds = [...new Set((due ?? []).map((o) => o.listing_id))];
    // Chunked: BATCH is 200, so this could carry 200 UUIDs in one `.in()` —
    // about 8 KB of query string against a limit chunked-in.ts puts at 8 KB.
    // On failure this route 502s without stamping any reminder, so the next run
    // reads the same 200 orders and 502s again: a stall that does not clear.
    const { data: listings, error: listingError } = await readInChunks<
      { id: string; title: string }, { message: string }
    >(listingIds, (chunk) => admin.from('marketplace_listings').select('id, title').in('id', chunk));
    if (listingError) {
      console.error('Return-reminders listing lookup failed:', listingError);
      return NextResponse.json({ ok: false, error: t('returnReminders.couldNotLoadListingTitles') }, { status: 502 });
    }
    const titleOf = new Map((listings ?? []).map((l) => [l.id, l.title]));

    let reminded = 0, overdue = 0, failed = 0;
    for (const o of due ?? []) {
      const order = {
        kind: o.kind, status: o.status, endsOn: o.ends_on, returnedAt: o.returned_at,
        dueReminderSentAt: o.due_reminder_sent_at, overdueNotifiedAt: o.overdue_notified_at,
      };
      const title = titleOf.get(o.listing_id) ?? 'a borrowed item';
      const verb = o.kind === 'rent' ? 'rental' : 'borrowed item';

      // Without the family's zone there is no honest answer to "is this due
      // today", so this order is a failure rather than a guess. The send would
      // have failed on the same missing scope anyway; deciding here only moves
      // the failure to where the reason is legible.
      const scope = await scopeFor(o.family_id);
      if (!scope) {
        console.error(`Return-reminders scope unavailable for ${o.id}; cannot resolve the family's day.`);
        failed++;
        continue;
      }
      const todayKey = dayKeyInTz(now, scope.tz);
      const readKey = await readDayFor(scope);

      if (needsOverdueAlert(order, todayKey)) {
        const claim = await claimStamp('overdue_notified_at', o.id);
        if (claim === 'error') { failed++; continue; }
        if (claim === 'taken') continue; // another run holds it, or the order is gone
        const late = Math.abs(daysUntilDue(o.ends_on, readKey) ?? 0);
        // Its OWN identity. The due-soon nudge went out under `relatedId: o.id`
        // and notify()'s default guard drops a recipient whose row under the
        // same type and related_id is still unread, so the overdue alert was
        // never delivered to anyone who had not opened the due-soon notice —
        // and was stamped as sent. `once`: an overdue alert is said one time.
        const notified = await notifyFamily(o.family_id, {
          ...overdueWords(title, verb, late),
          relatedType: 'marketplace_orders', relatedId: `${o.id}:overdue`, once: true,
        });
        if (!notified) {
          console.error(`Return-reminders overdue notification failed for ${o.id}`);
          await restoreStamp('overdue_notified_at', o.id);
          failed++;
        } else {
          overdue++;
        }
        continue; // don't also send a due-soon nudge for the same order
      }

      if (needsDueReminder(order, todayKey)) {
        const claim = await claimStamp('due_reminder_sent_at', o.id);
        if (claim === 'error') { failed++; continue; }
        if (claim === 'taken') continue;
        // Read the morning after its due day, a nudge due today is already late,
        // and says so rather than "Due today".
        const d = daysUntilDue(o.ends_on, readKey) ?? 0;
        const notified = await notifyFamily(o.family_id, {
          ...(d < 0 ? overdueWords(title, verb, -d) : {
            title: `Due ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}: "${title}"`,
            body: `Time to return this ${verb}. Tap to see the exchange details.`,
          }),
          relatedType: 'marketplace_orders', relatedId: `${o.id}:due`,
        });
        if (!notified) {
          console.error(`Return-reminders due notification failed for ${o.id}`);
          await restoreStamp('due_reminder_sent_at', o.id);
          failed++;
        } else {
          reminded++;
        }
      }
    }

    const ok = failed === 0;
    return NextResponse.json({ ok, reminded, overdue, failed }, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error('Return-reminders cron error:', err);
    return NextResponse.json({ ok: false, error: t('returnReminders.returnRemindersCronFailed') }, { status: 500 });
  }
}
