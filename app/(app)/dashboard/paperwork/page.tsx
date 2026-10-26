import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { PaperworkModule } from '@/components/modules/paperwork-module';
import type { Tables } from '@/lib/database.types';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { addedInScope, readsHouseholdMoney } from '@/lib/finance/household-money';
import { readAll } from '@/lib/supabase/read-all';

/** What still needs someone (0169's status CHECK): read to the end. */
const OPEN_STATUSES = ['needs_action', 'in_progress'];
/** What is settled: the newest 500 are history enough. */
const SETTLED_STATUSES = ['done', 'archived'];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('paperwork.paperworkInbox') };
}
export const dynamic = 'force-dynamic';

/**
 * Paperwork Inbox — one triage surface for the paper that floods families:
 * permission slips, school notices, medical forms, bills, flyers. AI-triaged on
 * capture; every extracted action materializes one-tap into a real calendar
 * event or reminder.
 */
export default async function PaperworkPage() {
  const t = await getTranslations();
  // Part of the Documents area (it steps up as `documents`), with no catalog
  // entry of its own: gated as /dashboard/files/* are.
  const ctx = await requireFeature('/dashboard/documents');
  await requireAal2(ctx, 'documents', '/dashboard/paperwork');
  const supabase = await createServer();

  // Degrades safely before migration 0169 — but ONLY for that.
  //
  // The `try/catch` here described a guard that was not there. A supabase-js
  // query RESOLVES with `{ data, error }` for anything the database answers,
  // including a refused read; it rejects only when the request never completed
  // (see lib/supabase/settle.ts). So the catch never saw an RLS refusal or a
  // query error, and `data ?? []` turned one into an empty inbox.
  //
  // The module's default filter is `needs_action`, and its empty state for that
  // filter reads "Inbox zero 🎉 — nothing needs your signature, payment, or
  // reply." That is the most confident sentence on the page, and a refused read
  // rendered it verbatim. The items behind it are permission slips, medical
  // forms and bills, each carrying a deadline the whole feature exists to catch;
  // a parent told they are at inbox zero does not go looking. Worse, the inbox
  // is a triage surface, so the natural response to an empty one is to capture
  // the paper again — re-running AI extraction and re-materializing calendar
  // events and reminders that already exist.
  //
  // A genuinely missing relation still degrades, because that is what the
  // original comment was for. Anything else fails closed. Audit C1-S9-30.
  //
  // The paperwork is a parent's or adult's, and whoever added an item keeps
  // reading it (the held 0514): anyone else's read is narrowed to what they
  // added before the limit, and the module says so.
  //
  // EVERY OPEN ITEM, AND ONLY THE SETTLED ONES CAPPED. One read of the newest
  // 500 rows of any status used to be the whole inbox: rows only accumulate
  // (no delete path; email attachments and captures file on their own), so a
  // family past 500 lost its OLDEST still-open slips — exactly the ones left
  // in needs_action — and the chip counts with them, and with no needs_action
  // row among the newest 500 the page said "Inbox zero". The open statuses are
  // now read to the end, paged; done and archived keep the 500 cap, which is
  // only a history.
  const seesAll = readsHouseholdMoney(ctx.active.role);
  const openRead = readAll<Tables<'paperwork_items'>>((from, to) => {
    const open = supabase.from('paperwork_items').select('*').eq('family_id', ctx.active.familyId).in('status', OPEN_STATUSES);
    return (seesAll ? open : open.eq('created_by', ctx.user.id))
      .order('created_at', { ascending: false }).order('id').range(from, to);
  }, { max: 20_000 });
  const scoped = supabase.from('paperwork_items').select('*').eq('family_id', ctx.active.familyId).in('status', SETTLED_STATUSES);
  const inbox = await (seesAll ? scoped : scoped.eq('created_by', ctx.user.id))
    .order('created_at', { ascending: false })
    .order('id')
    .limit(500);
  const open = await openRead;
  const failed = (
    <div className="module-page">
      <PageHeader title={t('paperwork.paperworkInbox')} description={t('paperworkModule.pasteAnySlipFormOr')} />
      <ErrorState message={t('paperwork.couldNotLoadYourInbox')} />
    </div>
  );
  if (inbox.error && !isMissingRelationError(inbox.error)) return failed;
  if (open.error && !isMissingRelationError(open.error)) return failed;
  const items = addedInScope([...open.rows, ...((inbox.data ?? []) as Tables<'paperwork_items'>[])], ctx.active.role, ctx.user.id);

  return <PaperworkModule items={items} ownOnly={!seesAll} />;
}
