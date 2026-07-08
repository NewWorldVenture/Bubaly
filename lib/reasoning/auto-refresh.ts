import 'server-only';
import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';
import { shouldAutoRefreshGraph } from '@/lib/planning/refresh';

type DB = SupabaseClient<Database>;

/**
 * R3 — keep the Knowledge Graph current at the point of use. When a graph surface
 * loads (via `loadFamilyGraph`) and the family was marked dirty by a source-data
 * change (the `0134` `family_model_dirty` trigger), re-project the twin in the
 * BACKGROUND with Next's `after()` — it runs after the response is sent, so the
 * page isn't slowed — then clear the dirty flag. The next read is fresh; no manual
 * "Rebuild from data" needed.
 *
 * Throttled: `shouldAutoRefreshGraph` requires dirty AND a cooled-down last refresh,
 * so opening several graph surfaces at once doesn't stampede the projector. The
 * projection is idempotent (upserts) and best-effort; the twice-daily model-refresh
 * cron remains the backstop. Never throws — a reasoning read must never break.
 */
export async function scheduleGraphAutoRefresh(supabase: DB, familyId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('family_model_dirty')
      .select('dirty, refreshed_at')
      .eq('family_id', familyId)
      .maybeSingle();

    if (!data || !shouldAutoRefreshGraph({ dirty: data.dirty ?? false, refreshedAt: data.refreshed_at ?? null })) {
      return;
    }

    after(async () => {
      try {
        const svc = createServiceClient();
        const res = await runTwinProjection(svc, familyId, null);
        if (res.ok) {
          await svc
            .from('family_model_dirty')
            .upsert({ family_id: familyId, dirty: false, refreshed_at: new Date().toISOString() }, { onConflict: 'family_id' });
        }
      } catch {
        /* best-effort; the model-refresh cron is the backstop */
      }
    });
  } catch {
    /* never break a read on the auto-refresh path */
  }
}
