import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { PaperworkModule } from '@/components/modules/paperwork-module';
import type { Tables } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { isMissingRelationError } from '@/lib/supabase/errors';

export const metadata: Metadata = { title: 'Paperwork Inbox' };
export const dynamic = 'force-dynamic';

/**
 * Paperwork Inbox — one triage surface for the paper that floods families:
 * permission slips, school notices, medical forms, bills, flyers. AI-triaged on
 * capture; every extracted action materializes one-tap into a real calendar
 * event or reminder.
 */
export default async function PaperworkPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
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
  const inbox = await supabase
    .from('paperwork_items').select('*')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (inbox.error && !isMissingRelationError(inbox.error)) {
    return (
      <div className="module-page">
        <PageHeader title={t('paperwork.paperworkInbox')} description={t('paperworkModule.pasteAnySlipFormOr')} />
        <ErrorState message={t('paperwork.couldNotLoadYourInbox')} />
      </div>
    );
  }
  const items = (inbox.data ?? []) as Tables<'paperwork_items'>[];

  return <PaperworkModule items={items} />;
}
