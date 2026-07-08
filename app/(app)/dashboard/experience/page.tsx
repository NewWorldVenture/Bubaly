import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ExperienceScorecardModule } from '@/components/modules/experience-scorecard-module';
import { TimeSavedBanner } from '@/components/metric/time-saved-banner';
import { loadTimeSaved } from '@/lib/metric/time-saved-server';

export const metadata: Metadata = { title: 'Experience Scorecard | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function ExperiencePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R11 — the North-Star metric leads the scorecard: time saved this week.
  const timeSaved = await loadTimeSaved(supabase, ctx.active.familyId);

  return (
    <>
      {timeSaved.show && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <TimeSavedBanner data={timeSaved} />
        </div>
      )}
      <ExperienceScorecardModule />
    </>
  );
}
