import type { Metadata } from 'next';
import Link from 'next/link';
import { History } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ConciergeModule } from '@/components/modules/concierge-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'AI Concierge' };
export const dynamic = 'force-dynamic';

export default async function ConciergePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: the concierge reasons over Knowledge Graph relationships. Keep the
  // primary module available, but make a failed shared read visible.
  let reasoning = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, ctx.active.familyId);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard/concierge] reasoning context read failed', error);
  }
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {/* M35: the one chronological list of everything Bubaly has done and is
          doing for this family. Linked here and from Home, never the sidebar. */}
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <Link
          href="/dashboard/concierge/runs"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3.5 text-sm font-medium text-fg transition hover:bg-elevated focus-ring"
        >
          <History className="h-4 w-4 text-brand-text" aria-hidden /> {t('concierge.runHistory')}
          <span className="hidden text-xs text-muted sm:inline">{t('concierge.everythingBubalyHasDoneAnd')}</span>
        </Link>
      </div>
      {reasoningError && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <ErrorState message={t('concierge.relationshipInsightsAreTemporarilyUnavailable')} />
        </div>
      )}
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <ConciergeModule />
    </>
  );
}
