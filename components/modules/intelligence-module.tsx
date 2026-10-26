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
  async function save(write: () => PromiseLike<{ data: Consent[] | null; error: unknown }>, done: string, narrows = false) {
    setSaving(true);
    try {
      const { data: saved, error } = await write();
      if (error) { toastError(describeDbError(error)); return; }
      if (wroteNoRows(saved)) { toastError(t('errors.thatChangeWasNotSaved')); return; }
      setData(saved as Consent[]);
      // Leaving, or switching off a scope that contributes (toggleScope
      // below), takes the family's stored contribution with it now (design
      // doc §2.7). The nightly aggregation only re-reads consent, so until a
      // run got all the way to its prune the row stayed. The published figures
      // are not rebuilt by this delete or by the next night: they are held for
      // the publication epoch, and the family's share of them goes with the
      // next epoch's snapshot (lib/network/aggregate.ts, PUBLICATION_EPOCH).
      // Zero rows is the ordinary answer for a family that has not
      // contributed yet.
      if (narrows) {
        const { error: forgetError } = await createClient().from('network_contributions')
          .delete().eq('family_id', familyId).select('family_id');
        if (forgetError) { toastError(describeDbError(forgetError)); return; }
      }
      success(done);
    } finally {
      setSaving(false);
    }
  }

  const toggleMaster = () => {
    const next: ConsentState = { enabled: !consent.enabled, scopes: consent.enabled ? {} : consent.scopes };
    return save(() => createClient().from('network_consent').upsert({
      family_id: familyId,
      enabled: next.enabled,
      scopes: next.scopes,
      consented_by: next.enabled ? userId : null,
      consented_at: next.enabled ? new Date().toISOString() : null,
    }, { onConflict: 'family_id' }).select('*'), next.enabled ? t('intelligence.preferencesSaved') : t('intelligence.leftTheNetwork'), !next.enabled);
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
  const toggleScope = (k: ConsentScope) =>
    save(() => createClient().from('network_consent')
      .update({ scopes: { ...consent.scopes, [k]: !consent.scopes[k] }, consented_by: userId, consented_at: new Date().toISOString() })
      .eq('family_id', familyId).eq('enabled', true).select('*'), t('intelligence.preferencesSaved'),
    consent.scopes[k] === true && contributesToNetwork({ [k]: true }));

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
