// /dashboard/inbox — the one household queue.
//
// Three tables carry what arrives at a household and, until now, three screens
// showed them: `family_inbox_messages` (the Contact Center's email/SMS/voice),
// `paperwork_items` (what triage read off a form or a bill) and
// `family_communications` (the hand-kept Communications Hub log). This page
// reads all three through `lib/inbox/server.ts`, merges them with
// `lib/inbox/unify.ts` and puts the ranked queue above the Hub it used to be
// the only view of.
//
// FAIL CLOSED, PER SOURCE. The loader logs each failing read and marks that
// source unavailable; all three failing renders a retryable error rather than
// an empty queue. "Nothing arrived" and "we could not look" are different
// facts, and this page never lets the second look like the first.
//
// NO MIGRATION: nothing is inserted into `family_inbox_messages` to make the
// merge work. Its `channel` CHECK admits only email/sms/voice and its RLS gives
// members SELECT only, so paperwork and log rows are merged at READ time and
// keep living in their own tables.
import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ErrorState } from '@/components/ui/states';
import { InboxModule } from '@/components/modules/inbox-module';
import { InboxQueue } from '@/components/modules/inbox-queue';
import { loadInboxQueue } from '@/lib/inbox/server';

export const metadata: Metadata = { title: 'Household Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const t = await getTranslations();
  const ctx = await requireFeature('/dashboard/inbox');
  const supabase = await createServer();
  const queue = await loadInboxQueue(supabase, ctx.active.familyId);

  if (queue.allFailed) {
    return <ErrorState message={t('inbox.couldNotLoadTheHouseholdInbox')} />;
  }

  return (
    <>
      <div className="module-page pb-0">
        <InboxQueue items={queue.items} needsYou={queue.needsYou} unavailable={queue.unavailable} />
      </div>
      <InboxModule />
    </>
  );
}
