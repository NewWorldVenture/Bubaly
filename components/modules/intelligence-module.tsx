'use client';

// Family Intelligence Network — the opt-in privacy surface. Ships the CONSENT
// controls (default off, granular, revocable) + an honest, k-anonymity-gated
// insight area fed by the nightly aggregation. Until a family's cohort clears
// the floor the list is empty, and the empty state says so plainly rather than
// fabricating "insights". 100% Supabase + realtime.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Radar, ShieldCheck, Lock, Users, Info, Globe } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { isManager } from '@/lib/constants/roles';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import {
  CONSENT_SCOPES, K_ANONYMITY_FLOOR, consentedInsights, isContributing,
  type ConsentScope, type ConsentState, type NetworkInsight,
} from '@/lib/network/insights';
import type { ContributionBucket } from '@/lib/network/contribution';
import { contributesToNetwork } from '@/lib/network/aggregate';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';
import { withdrawFromNetworkAction } from '@/app/(app)/dashboard/intelligence/actions';

type Consent = Tables<'network_consent'>;

export function IntelligenceModule({
  contribution = [],
  candidates = [],
  benchmarksPublished = false,
}: {
  contribution?: ContributionBucket[];
  /** Already past the k-floor on the server (publishableInsights): noised counts only, no true size. */
  candidates?: NetworkInsight[];
  /** Read server-side from the marketing_settings publication flag. False means
   *  /resources/benchmarks does not exist right now, so nothing links to it. */
  benchmarksPublished?: boolean;
}) {
  const t = useTranslations();
  const { familyId, userId, role, members } = useApp();
  // Joining the network shares the family's (anonymised) data, so it is the
  // family managers' decision — a minor's toggle is not consent. The database
  // enforces the same since 0353; other members see the setting read-only.
  const canConsent = isManager(role);
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const { data: rows, loading, error, refresh, setData } = useRealtimeQuery<Consent>({
    table: 'network_consent', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('network_consent').select('*').eq('family_id', familyId),
  });
  const row = (rows ?? [])[0];

  const consent: ConsentState = useMemo(() => ({
    enabled: row?.enabled ?? false,
    scopes: (row?.scopes as ConsentState['scopes']) ?? {},
  }), [row]);

  // Candidates come from the aggregation cron (server-fetched for this family's
  // cohort), already past the k-floor on the server, which is where the true
  // band size stays; consent is re-checked here against the row on screen.
  const insights = useMemo(() => consentedInsights(candidates, consent), [candidates, consent]);
  const contributing = isContributing(consent);
  // A consent switched on by an ACTIVE member who may not give it (a teen,
  // child, guest or caregiver — before 0353 anyone could) is not honoured: the
  // nightly aggregation drops it (consentsByNonManagers). "You're
  // contributing" over it was false, so the family is told that a manager
  // needs to confirm it — which any manager's switch below does.
  const consentNeedsAManager = !!row?.consented_by
    && (members ?? []).some((m) => m.user_id === row.consented_by && !isManager(m.role));

  // `network_consent` is not in REALTIME_TABLES, so no channel ever moves this
  // screen. Each toggle builds the NEXT state from `consent`, so after a write
  // the row it wrote is put on screen before the toggles come back: built from
  // the page-load row instead, a tap after "Leave network" rejoined the family
  // and a second scope switched off turned the first one back on — consent the
  // nightly aggregation then honours. `saving` holds every toggle until then.
  //
  // A write that matched no row found the row changed since this screen read
  // it (another tab or device, or RLS), so the screen reads it again before
  // the toggles come back: the next tap then builds from the stored row.
  async function save(write: () => PromiseLike<{ data: Consent[] | null; error: unknown }>, done: string) {
    setSaving(true);
    try {
      const { data: saved, error } = await write();
      if (error) { toastError(describeDbError(error)); return; }
      if (wroteNoRows(saved)) { toastError(t('errors.thatChangeWasNotSaved')); await refresh(); return; }
      setData(saved as Consent[]);
      success(done);
    } finally {
      setSaving(false);
    }
  }

  // Leaving, or switching off a scope that contributes (toggleScope below),
  // takes the family's stored contribution with it now (design doc §2.7), on
  // the server (withdrawFromNetworkAction), under the claim the nightly
  // aggregation publishes under: written from here, a run that had read
  // consent before the leave stored the row again after this delete and
  // published it after the toast said the family had left. The published
  // figures are not rebuilt by it: they are held for the publication epoch,
  // and the family's share of them goes with the next epoch's snapshot
  // (lib/network/aggregate.ts, PUBLICATION_EPOCH), which the toast says.
  // `fenced: false` is a withdrawal written without the claim (it was held
  // past the wait, or could not be read), and the toast says what that leaves
  // open. It names the household and member on screen: the server's active
  // household is shared by every tab and device, so a tab left open here after
  // another household was chosen elsewhere withdrew THAT one, and this one
  // went on contributing. The action refuses unless both are still active.
  //
  // A call that THROWS rather than answering (offline, a deploy that retired
  // this tab's action, the server failing to read the session) left the
  // member with no word and the switch as it was, as if the leave had
  // happened somewhere out of sight. It is said now, like any refusal.
  async function withdraw(change: Parameters<typeof withdrawFromNetworkAction>[0], done: { fenced: string; unfenced: string }) {
    setSaving(true);
    try {
      const result = await withdrawFromNetworkAction(change, { expectedFamilyId: familyId, expectedUserId: userId });
      // The consent that was written goes on screen even when the forget
      // failed: a screen still showing "joined" rejoins on the next tap.
      if (result.rows) setData(result.rows);
      if (!result.ok) { toastError(result.error); return; }
      success(result.fenced ? done.fenced : done.unfenced);
    } catch (err) {
      console.error('[intelligence] withdrawal failed', err);
      toastError(t('errors.thatChangeWasNotSaved'));
    } finally {
      setSaving(false);
    }
  }

  const toggleMaster = () => {
    if (consent.enabled) {
      return withdraw({ leave: true }, {
        fenced: t('intelligence.leftTheNetwork', { floor: K_ANONYMITY_FLOOR }),
        unfenced: t('intelligence.leftTheNetworkWhilePublishing', { floor: K_ANONYMITY_FLOOR }),
      });
    }
    // Joining is written against the row this screen read, as a scope switch
    // is (below): a second tab still showing the family out of the network
    // wrote its old map over the one chosen in the first since. With a row, it
    // joins only while that row is still out with the same map; with none, it
    // inserts only while there is still none. Changed elsewhere, it writes
    // nothing, and the screen reads the row again (save).
    const joined = { enabled: true, scopes: consent.scopes, consented_by: userId, consented_at: new Date().toISOString() };
    return save(() => (row
      ? createClient().from('network_consent').update(joined)
        .eq('family_id', familyId).eq('enabled', false).eq('scopes', JSON.stringify(row.scopes)).select('*')
      : createClient().from('network_consent')
        .upsert({ family_id: familyId, ...joined }, { onConflict: 'family_id', ignoreDuplicates: true }).select('*')),
    t('intelligence.preferencesSaved'));
  };
  // A scope switch changes the scopes, and records the manager who made it as
  // the consent's author: the nightly aggregation honours a consent only when
  // its author may give it, so a manager's choice here takes over one that a
  // member who may not give it wrote. Joining or leaving is the master
  // switch's decision alone, so this never writes `enabled`, and it writes
  // nothing to a row that is no longer in the network.
  //
  // Only a scope that contributes takes the stored contribution with it:
  // `timing` and `recommendations` have no metric, so switching one of them
  // off forgets nothing, and deleting the row then only cost the family its
  // digest compare line until the next nightly run.
  //
  // Neither path may write a map older than the stored one. A second tab of
  // the household keeps the map it loaded (no realtime here), and writing it
  // whole switched back on a scope the first tab had switched off: benchmarks,
  // confirmed off and its row deleted, contributing again the next night. So
  // the switch-off sends only the scope it turns off, which the server applies
  // to the stored map, and the direct write is a compare-and-set on the map
  // this screen built from: changed elsewhere, it writes nothing, and the
  // screen reads the row again (save).
  const toggleScope = (k: ConsentScope) => {
    if (consent.scopes[k] === true && contributesToNetwork({ [k]: true })) {
      return withdraw({ scopes: { [k]: false } }, { fenced: t('intelligence.preferencesSaved'), unfenced: t('intelligence.preferencesSavedWhilePublishing') });
    }
    const scopes = { ...consent.scopes, [k]: !consent.scopes[k] };
    return save(() => createClient().from('network_consent')
      .update({ scopes, consented_by: userId, consented_at: new Date().toISOString() })
      .eq('family_id', familyId).eq('enabled', true).eq('scopes', JSON.stringify(row?.scopes ?? {}))
      .select('*'), t('intelligence.preferencesSaved'));
  };

  if (loading) return <div className="rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted">{t('intelligence.loadingIntelligencePreferences')}</div>;
  if (error) return <ErrorState message={t('intelligenceModule.couldNotLoadIntelligencePreferences')} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader title={t('intelligence.intelligenceNetwork')} description={t('intelligenceModule.optInToLearnFrom')} />

      {/* Privacy promise */}
      <div className="rounded-xl border border-border bg-surface/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="size-5 text-emerald-400" />
          <h3 className="font-semibold">{t('intelligence.howYourPrivacyIsProtected')}</h3>
        </div>
        <ul className="grid gap-2 text-sm text-muted sm:grid-cols-2">
          <li className="flex items-start gap-2"><Lock className="mt-0.5 size-4 shrink-0" /> {t('intelligence.offByDefaultNothingIsShared')}</li>
          <li className="flex items-start gap-2"><Users className="mt-0.5 size-4 shrink-0" /> {t('intelligence.onlyAggregatePatternsFromAtLeastFamilies', { floor: K_ANONYMITY_FLOOR })}</li>
          <li className="flex items-start gap-2"><Info className="mt-0.5 size-4 shrink-0" /> {t('intelligence.granularPickExactlyWhatYouContribute')}</li>
          <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" /> {t('intelligence.reversibleAnytimeLeavingStopsAllSharing')}</li>
        </ul>
      </div>

      {/* Informed consent: exactly what you'd contribute (coarse, own data, never shared here) */}
      {contribution.length > 0 && (
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="mb-1 flex items-center gap-2">
            <Info className="size-5 text-brand-text" />
            <h3 className="font-semibold">{t('intelligence.whatYoudContribute')}</h3>
          </div>
          <p className="mb-3 text-sm text-muted">{t('intelligenceModule.onlyTheseCoarseAnonymizedBands')}</p>
          <div className="flex flex-wrap gap-2">
            {contribution.map((b) => (
              <span key={b.labelKey} className="rounded-full border border-border px-3 py-1 text-xs">
                {/* The band is what the family reads, so it is translated too —
                    `b.value` is the stored English band, not the rendered one. */}
                <span className="text-muted">{t(b.labelKey)}:</span>{' '}
                {b.valueBands.map((v) => (v.labelKey ? t(v.labelKey) : v.value)).join(', ')}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Master toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface/40 p-4">
        <div>
          <h3 className="font-semibold">{t('intelligence.joinTheIntelligenceNetwork')}</h3>
          <p className="text-sm text-muted">
            {!contributing ? t('intelligence.privateStatus')
              : consentNeedsAManager ? t('intelligence.consentNeedsAManager') : t('intelligence.contributingStatus')}
          </p>
        </div>
        <Toggle on={consent.enabled} disabled={saving || !canConsent} onClick={toggleMaster} label={t('intelligence.joinTheNetwork')} />
      </div>

      {/* Scopes */}
      {consent.enabled && (
        <div className="space-y-2">
          {CONSENT_SCOPES.map((s) => (
            <div key={s.key} className="flex items-center justify-between rounded-xl border border-border bg-surface/40 p-4">
              <div className="pr-4">
                <h4 className="text-sm font-semibold">{t(s.labelKey)}</h4>
                <p className="text-xs text-muted">{t(s.descriptionKey)}</p>
              </div>
              <Toggle on={consent.scopes[s.key] === true} disabled={saving || !canConsent} onClick={() => toggleScope(s.key)} label={t(s.labelKey)} />
            </div>
          ))}
        </div>
      )}

      {/* Insights (k-anonymity gated; empty until this family's cohort clears the floor) */}
      {contributing && (
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="mb-3 flex items-center gap-2"><Radar className="size-5 text-brand-text" /><h3 className="font-semibold">{t('intelligence.networkInsights')}</h3></div>
          {insights.length === 0 ? (
            <p className="text-sm text-muted">{t('intelligence.noInsightsYet', { floor: K_ANONYMITY_FLOOR })}</p>
          ) : (
            <ul className="space-y-2">
              {insights.map((i) => (
                <li key={i.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{i.title}</span>
                    {/* The confidence only: the one family count is the noised one in the
                        detail below. The true band size beside it cancelled the noise. */}
                    <span className="text-[10px] uppercase text-muted">{i.confidence}</span>
                  </div>
                  <p className="text-sm text-muted">{i.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The same k-anonymized rows, published for everyone — the research half of
          the network. Shown ONLY while the admin publication flag says the page
          exists: /resources/benchmarks calls notFound() otherwise, and a card
          claiming rows are "published for everyone" while the link 404s is a
          claim with no row behind it. The flag is read server-side. */}
      {benchmarksPublished && (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-4">
          <Globe className="mt-0.5 size-5 shrink-0 text-brand-text" />
          <div>
            <Link href="/resources/benchmarks" className="text-sm font-semibold underline">{t('intelligence.seePublicBenchmarks')}</Link>
            <p className="text-xs text-muted">{t('intelligence.publicBenchmarksHint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition', on ? 'bg-emerald-500' : 'bg-muted/30', disabled && 'opacity-60')}
    >
      <span className={cn('absolute top-0.5 size-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}
