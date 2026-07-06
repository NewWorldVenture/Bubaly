'use client';

// Family Intelligence Network — the opt-in privacy surface. Ships the CONSENT
// controls (default off, granular, revocable) + an honest, k-anonymity-gated
// insight area. No cross-family data is aggregated yet, so the insight list is
// empty by design until that pipeline is built and signed off; the empty state
// says so plainly rather than fabricating "insights". 100% Supabase + realtime.
import { useMemo, useState } from 'react';
import { Radar, ShieldCheck, Lock, Users, Info } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  CONSENT_SCOPES, K_ANONYMITY_FLOOR, visibleInsights, isContributing,
  type ConsentScope, type ConsentState, type InsightCandidate,
} from '@/lib/network/insights';
import type { ContributionBucket } from '@/lib/network/contribution';
import type { Tables } from '@/lib/database.types';

type Consent = Tables<'network_consent'>;

// No cross-family aggregation pipeline exists yet (deferred pending sign-off), so
// there are no real candidates. The k-floor gate below would suppress anything
// under-supported regardless.
const CANDIDATES: InsightCandidate[] = [];

export function IntelligenceModule({ contribution = [] }: { contribution?: ContributionBucket[] }) {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  const { data: rows } = useRealtimeQuery<Consent>({
    table: 'network_consent', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('network_consent').select('*').eq('family_id', familyId),
  });
  const row = (rows ?? [])[0];

  const consent: ConsentState = useMemo(() => ({
    enabled: row?.enabled ?? false,
    scopes: (row?.scopes as ConsentState['scopes']) ?? {},
  }), [row]);

  const insights = useMemo(() => visibleInsights(CANDIDATES, consent), [consent]);
  const contributing = isContributing(consent);

  async function persist(next: ConsentState) {
    setSaving(true);
    const sb = createClient();
    const { error } = await sb.from('network_consent').upsert({
      family_id: familyId,
      enabled: next.enabled,
      scopes: next.scopes,
      consented_by: next.enabled ? userId : null,
      consented_at: next.enabled ? new Date().toISOString() : null,
    }, { onConflict: 'family_id' });
    setSaving(false);
    if (error) { toastError(describeDbError(error)); return; }
    success(next.enabled ? 'Preferences saved' : 'Left the network — nothing is shared');
  }

  const toggleMaster = () => persist({ enabled: !consent.enabled, scopes: consent.enabled ? {} : consent.scopes });
  const toggleScope = (k: ConsentScope) =>
    persist({ enabled: true, scopes: { ...consent.scopes, [k]: !consent.scopes[k] } });

  return (
    <div className="space-y-6">
      <PageHeader title="Intelligence Network" description="Opt in to learn from anonymized patterns across similar families — or stay fully private. Your choice, always reversible." />

      {/* Privacy promise */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="size-5 text-emerald-400" />
          <h3 className="font-semibold">How your privacy is protected</h3>
        </div>
        <ul className="grid gap-2 text-sm text-muted sm:grid-cols-2">
          <li className="flex items-start gap-2"><Lock className="mt-0.5 size-4 shrink-0" /> Off by default. Nothing is shared unless you turn it on.</li>
          <li className="flex items-start gap-2"><Users className="mt-0.5 size-4 shrink-0" /> Only aggregate patterns from at least {K_ANONYMITY_FLOOR} families — never an individual.</li>
          <li className="flex items-start gap-2"><Info className="mt-0.5 size-4 shrink-0" /> Granular: pick exactly what you contribute.</li>
          <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" /> Reversible anytime — leaving stops all sharing immediately.</li>
        </ul>
      </div>

      {/* Informed consent: exactly what you'd contribute (coarse, own data, never shared here) */}
      {contribution.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-1 flex items-center gap-2">
            <Info className="size-5 text-brand" />
            <h3 className="font-semibold">What you’d contribute</h3>
          </div>
          <p className="mb-3 text-sm text-muted">
            Only these coarse, anonymized bands — never names, exact ages, or precise counts. Shown
            here from your own data so you can decide with your eyes open. Nothing is shared unless you join.
          </p>
          <div className="flex flex-wrap gap-2">
            {contribution.map((b) => (
              <span key={b.label} className="rounded-full border border-border px-3 py-1 text-xs">
                <span className="text-muted">{b.label}:</span> {b.value}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Master toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div>
          <h3 className="font-semibold">Join the Intelligence Network</h3>
          <p className="text-sm text-muted">{contributing ? 'You’re contributing anonymized patterns and can see network insights.' : 'Currently private — you’re not sharing or receiving anything.'}</p>
        </div>
        <Toggle on={consent.enabled} disabled={saving} onClick={toggleMaster} label="Join the network" />
      </div>

      {/* Scopes */}
      {consent.enabled && (
        <div className="space-y-2">
          {CONSENT_SCOPES.map((s) => (
            <div key={s.key} className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div className="pr-4">
                <h4 className="text-sm font-semibold">{s.label}</h4>
                <p className="text-xs text-muted">{s.description}</p>
              </div>
              <Toggle on={consent.scopes[s.key] === true} disabled={saving} onClick={() => toggleScope(s.key)} label={s.label} />
            </div>
          ))}
        </div>
      )}

      {/* Insights (k-anonymity gated; empty until the aggregation pipeline exists) */}
      {contributing && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2"><Radar className="size-5 text-brand" /><h3 className="font-semibold">Network insights</h3></div>
          {insights.length === 0 ? (
            <p className="text-sm text-muted">
              The network is still gathering enough families to share anything safely. Insights appear
              here only once a pattern is backed by at least {K_ANONYMITY_FLOOR} families — so nothing
              can ever be traced back to one household.
            </p>
          ) : (
            <ul className="space-y-2">
              {insights.map((i) => (
                <li key={i.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{i.title}</span>
                    <span className="text-[10px] uppercase text-muted">{i.confidence} · {i.cohortSize} families</span>
                  </div>
                  <p className="text-sm text-muted">{i.detail}</p>
                </li>
              ))}
            </ul>
          )}
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
