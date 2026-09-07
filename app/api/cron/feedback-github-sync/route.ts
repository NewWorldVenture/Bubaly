import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { runGithubFeedbackSync, summarizeSync } from '@/lib/feedback/github-sync';
import { notifySuperAdmins } from '@/lib/feedback/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The feedback ↔ GitHub bot. Runs on a schedule (vercel.json): backfills any
// unsynced ideas as issues, reads BOTH lists (bugs + enhancements), reflects
// each issue's state back onto its idea's status, and relays a digest to the
// super admin — but only when something actually changed (no empty-run noise).
// CRON_SECRET-gated like every other cron. Dark until GITHUB_* is configured.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('feedbackGithubSync.unauthorized') }, { status: 401 });
  }

  const admin = createServiceClient();
  const result = await runGithubFeedbackSync(admin);

  const changed = result.configured && (result.created > 0 || result.changes.length > 0 || result.errors > 0);
  if (changed) {
    const detail = result.changes.length
      ? result.changes.map((c) => `• ${c.title}: ${c.from} → ${c.to} (#${c.issue})`).join('\n')
      : undefined;
    await notifySuperAdmins(admin, {
      kind: result.errors ? 'github_error' : 'github_sync',
      title: `Feedback ↔ GitHub: ${summarizeSync(result)}`,
      body: detail,
      url: '/admin/feedback',
      relatedType: 'github_sync',
      // Email only on real status changes or errors — created-issue backfills
      // are already covered by the per-submission emails.
      email: result.changes.length > 0 || result.errors > 0,
    });
  }

  return NextResponse.json({ ok: true, ...result });
}
