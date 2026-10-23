import type { Metadata } from 'next';
import { Repeat, CircleAlert } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { PROVIDERS, PLATFORMS, providerReadiness } from '@/lib/social/capabilities';
import { CADENCES, describeSchedule } from '@/lib/marketing/recurring-ads';
import { campaignFinished, scheduleFromRow, type AdRow } from '@/lib/marketing/recurring-ads-runner';
import { RecurringAdControls, NewRecurringAdForm } from './controls';
import { safeWebLink } from '@/lib/utils/safe-link';

export const metadata: Metadata = { title: 'Marketing · Recurring social ads', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Campaigns Posts sent may add up before it says it is not shown (one round trip per 1,000). */
const SUM_ROW_CEILING = 10_000;

type RunRow = {
  id: string; ad_id: string; occurrence: number; platform: string;
  status: string; ran_at: string; error_message: string | null; permalink_url: string | null;
};

export default async function RecurringAdsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // Campaigns, Active and Posts sent were counted and summed from the list, an
  // unbounded read PostgREST answers with at most db-max-rows (coverage sweep
  // round 9, class B): they are head:true counts and a sum paged on the id now,
  // past whose ceiling Posts sent says it is not shown. A failed run history
  // read drew no history on any campaign, as if none had run (class A); each
  // campaign says its history could not be read instead.
  const counted = () => supabase.from('marketing_recurring_ads').select('id', { count: 'exact', head: true }).is('deleted_at', null);
  const [{ data: ads, error: adsError }, { data: runs, error: runsError }, campaignCountResult, activeCountResult, sentResult] = await settleAll([
    supabase.from('marketing_recurring_ads').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_recurring_ad_runs').select('*').order('ran_at', { ascending: false }).limit(60),
    counted(),
    counted().eq('status', 'active'),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_recurring_ads').select('id, occurrences').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]);
  const sentCeiling = 'truncated' in sentResult && sentResult.truncated;
  const campaignsError = adsError ?? campaignCountResult.error ?? activeCountResult.error ?? (sentCeiling ? null : sentResult.error);
  if (campaignsError) {
    console.error('[admin-recurring-ads] campaign read failed', campaignsError);
    return <ErrorState message="Recurring campaigns could not be read. Refresh, or check the server logs." />;
  }
  if (runsError) console.error('[admin-recurring-ads] run history read failed', runsError);
  const rows = (ads ?? []) as unknown as AdRow[];
  const postsSent = (sentResult.data ?? []).reduce((n, a) => n + (a.occurrences ?? 0), 0);
  const unavailable = t('strategyMetrics.unavailable');
  const recentRuns = (runs ?? []) as unknown as RunRow[];
  const runsByAd = new Map<string, RunRow[]>();
  for (const run of recentRuns) {
    const list = runsByAd.get(run.ad_id) ?? [];
    list.push(run);
    runsByAd.set(run.ad_id, list);
  }

  // Readiness is read from the environment, not from a flag someone can tick.
  const readiness = PLATFORMS.map((p) => ({ platform: p, label: PROVIDERS[p].label, state: providerReadiness(p) }));
  const readyCount = readiness.filter((r) => r.state === 'ready').length;
  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Set a campaign once and Bubaly keeps posting it on the cadence you choose — no one has to come back and press anything.
        Messages rotate through the list you give, so a long-running campaign does not repeat the same sentence forever.
      </div>

      {readyCount === 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-medium">No platform can publish yet.</p>
            <p className="text-muted">
              Campaigns you create here will run on schedule and record <strong>Requires setup</strong> for every platform until
              that platform&apos;s app credentials are in the environment. Nothing is marked as posted unless the platform confirms it.
              Add credentials under Social · Providers.
            </p>
          </div>
        </div>
      )}

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={sentCeiling ? [t('adminRecurringAds.postsSent')] : []}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><p className="text-xs text-muted">Campaigns</p><p className="text-2xl font-bold">{campaignCountResult.count ?? 0}</p></Card>
        <Card><p className="text-xs text-muted">Active</p><p className="text-2xl font-bold">{activeCountResult.count ?? 0}</p></Card>
        <Card><p className="text-xs text-muted">Posts sent</p><p className="text-2xl font-bold">{sentCeiling ? unavailable : postsSent}</p></Card>
        <Card><p className="text-xs text-muted">Platforms ready</p><p className="text-2xl font-bold">{readyCount}<span className="text-base text-muted">/{PLATFORMS.length}</span></p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {rows.length === 0 ? (
            <EmptyState icon={Repeat} title="No recurring campaigns yet" description="Create one on the right. It will post on its own from then on." />
          ) : rows.map((ad) => {
            const history = runsByAd.get(ad.id) ?? [];
            // "Finished" means no run is left — the cap, the END DATE, or no
            // slot inside the window (campaignFinished) — not just the cap. A
            // campaign retired on its end date is stored status 'paused' with
            // next_run_at null, so reading the cap alone badged it "Paused":
            // indistinguishable from one somebody paused on purpose last
            // Tuesday, and the obvious thing to do with a paused campaign is
            // start it again. RecurringAdControls hides BOTH Pause and Resume
            // for a finished campaign, as it always did for a capped one: an
            // active row past its end date has nothing left to pause (the next
            // tick retires it) and Resume would be refused. Post now and Remove
            // stay; Post now asks the same stopping rule itself.
            const finished = campaignFinished(ad, now);
            return (
              <Card key={ad.id} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{ad.name}</p>
                    <p className="text-xs text-muted">{describeSchedule(scheduleFromRow(ad))}</p>
                  </div>
                  <Badge tone={finished ? 'neutral' : ad.status === 'active' ? 'success' : 'warning'}>
                    {finished ? 'Finished' : ad.status === 'active' ? 'Active' : 'Paused'}
                  </Badge>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {(ad.platforms ?? []).map((p) => {
                    const known = PLATFORMS.includes(p as typeof PLATFORMS[number]);
                    const ready = known && providerReadiness(p as typeof PLATFORMS[number]) === 'ready';
                    return (
                      <Badge key={p} tone={ready ? 'success' : 'neutral'} className="capitalize">
                        {known ? PROVIDERS[p as typeof PLATFORMS[number]].label : p}{ready ? '' : ' · needs setup'}
                      </Badge>
                    );
                  })}
                </div>

                <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div><dt className="text-muted">Next post</dt><dd>{ad.next_run_at ? fmtDate(ad.next_run_at) : '—'}</dd></div>
                  <div><dt className="text-muted">Last post</dt><dd>{ad.last_run_at ? fmtDate(ad.last_run_at) : '—'}</dd></div>
                  <div><dt className="text-muted">Sent</dt><dd>{ad.occurrences}{ad.max_occurrences != null ? ` / ${ad.max_occurrences}` : ''}</dd></div>
                  <div><dt className="text-muted">Messages</dt><dd>{(ad.body_variants ?? []).length} in rotation</dd></div>
                </dl>

                {runsError ? (
                  <p className="text-xs text-muted">{t('adminRecurringAds.runHistoryUnavailable')}</p>
                ) : history.length > 0 && (
                  <details className="rounded-xl border border-border bg-surface/40 p-3">
                    <summary className="cursor-pointer text-xs font-medium">Recent runs ({history.length})</summary>
                    <ul className="mt-2 space-y-1.5">
                      {history.slice(0, 12).map((run) => (
                        <li key={run.id} className="flex flex-wrap items-center gap-2 text-xs">
                          <Badge tone={run.status === 'published' ? 'success' : run.status === 'failed' ? 'danger' : 'neutral'}>
                            {run.status.replace(/_/g, ' ')}
                          </Badge>
                          <span className="capitalize">{run.platform}</span>
                          <span className="text-muted">#{run.occurrence + 1} · {fmtDate(run.ran_at)}</span>
                          {run.permalink_url && <a href={safeWebLink(run.permalink_url) ?? undefined} className="text-brand-text underline" rel="noreferrer noopener" target="_blank">View</a>}
                          {run.error_message && <span className="text-muted">{run.error_message}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <RecurringAdControls id={ad.id} status={ad.status === 'active' ? 'active' : 'paused'} finished={finished} />
              </Card>
            );
          })}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">New recurring campaign</h2>
          <NewRecurringAdForm
            platforms={PLATFORMS.map((p) => ({ value: p, label: PROVIDERS[p].label, ready: providerReadiness(p) === 'ready' }))}
            cadences={CADENCES}
          />
        </Card>
      </div>
    </div>
  );
}
