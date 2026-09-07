// The four platform metrics the strategy is actually judged on, on the admin
// report: X3 rework, X5 decision compression, X10 conversion after value,
// X12 referral coefficient.
//
// A tile shows one of three things and never confuses them:
//   * a number, when the read succeeded and there is something to divide by;
//   * "not enough data yet", when the read succeeded and there genuinely is not
//     (no terminal run, no signal, no family past first value);
//   * "unavailable", when the read FAILED. Never 0, never a dash that reads
//     like a zero — the tile says the database did not answer.
import { GitBranch, Layers, TrendingUp, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { getTranslations } from '@/lib/i18n/server';
import type { StrategyMetrics } from '@/lib/metric/strategy-server';

type Tone = 'value' | 'sparse' | 'unavailable';

function toneClass(tone: Tone): string {
  return tone === 'value' ? 'text-xl font-bold leading-none'
    : tone === 'sparse' ? 'text-sm font-semibold leading-none text-muted'
      : 'text-sm font-semibold leading-none text-danger';
}

export async function StrategyMetricTiles({ metrics }: { metrics: StrategyMetrics }) {
  const t = await getTranslations();
  const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

  const unavailable = t('strategyMetrics.unavailable');
  const notEnough = t('strategyMetrics.notEnoughDataYet');

  const rework = metrics.rework;
  const reworkTile = rework === null
    ? { tone: 'unavailable' as Tone, value: unavailable, detail: t('strategyMetrics.theRunLedgerDidNotAnswer') }
    : rework.reworkRate === null
      ? { tone: 'sparse' as Tone, value: notEnough, detail: t('strategyMetrics.noRunHasFinishedInThisWindow') }
      : {
        tone: 'value' as Tone,
        value: pct(rework.reworkRate),
        detail: t('strategyMetrics.ofNTerminalRunsNeededRework', { count: rework.terminal }),
      };

  const compression = metrics.compression;
  const compressionTile = metrics.compressionRead === 'failed'
    ? { tone: 'unavailable' as Tone, value: unavailable, detail: t('strategyMetrics.theSignalCountsDidNotAnswer') }
    : compression === null
      ? { tone: 'sparse' as Tone, value: notEnough, detail: t('strategyMetrics.noSignalsInThisWindow') }
      : {
        tone: 'value' as Tone,
        value: t('strategyMetrics.nSignalsPerDecision', { ratio: compression.ratio }),
        detail: `${t(compression.labelKey)} · ${t('strategyMetrics.nSignalsNDecisions', { signals: compression.rawSignals, decisions: compression.humanDecisions })}`,
      };

  const conversion = metrics.conversion;
  const conversionTile = conversion === null
    ? { tone: 'unavailable' as Tone, value: unavailable, detail: t('strategyMetrics.theActivationLedgerDidNotAnswer') }
    : conversion.rate === null
      ? { tone: 'sparse' as Tone, value: notEnough, detail: t('strategyMetrics.noFamilyHasReachedFirstValueYet') }
      : {
        tone: 'value' as Tone,
        value: pct(conversion.rate),
        // The median is an upper bound whenever a conversion had to be dated
        // from the subscription row's `updated_at` instead of a billing event,
        // and the tile says "about" rather than printing it as measured.
        detail: conversion.medianDays === null
          ? t('strategyMetrics.ofNFamiliesPastFirstValue', { count: conversion.families })
          : conversion.medianDaysApproximate
            ? t('strategyMetrics.ofNFamiliesPastFirstValueMedianDaysApprox', { count: conversion.families, days: conversion.medianDays })
            : t('strategyMetrics.ofNFamiliesPastFirstValueMedianDays', { count: conversion.families, days: conversion.medianDays }),
      };

  const referrals = metrics.referrals;
  const referralTile = referrals === null
    ? { tone: 'unavailable' as Tone, value: unavailable, detail: t('strategyMetrics.theReferralLedgerDidNotAnswer') }
    : referrals.coefficient === null
      ? { tone: 'sparse' as Tone, value: notEnough, detail: t('strategyMetrics.noHouseholdsToDivideBy') }
      : {
        tone: 'value' as Tone,
        value: referrals.coefficient.toFixed(2),
        // Households only. Accepted invites add a member to a family that
        // already exists, so they are shown beside the number rather than
        // inside it — a coefficient above 1 has to mean new households.
        detail: `${t('strategyMetrics.nOfNHouseholdsJoinedThroughAReferral', { joined: referrals.joined, households: referrals.households })} · ${t('strategyMetrics.nMembersInvitedIntoExistingHouseholds', { count: referrals.membersInvited })}`,
      };

  const tiles = [
    { key: 'rework', icon: GitBranch, label: t('strategyMetrics.reworkRate'), tint: 'text-amber-400 bg-amber-500/15', ...reworkTile },
    { key: 'compression', icon: Layers, label: t('strategyMetrics.decisionCompression'), tint: 'text-violet-400 bg-violet-500/15', ...compressionTile },
    { key: 'conversion', icon: TrendingUp, label: t('strategyMetrics.conversionAfterValue'), tint: 'text-emerald-400 bg-emerald-500/15', ...conversionTile },
    { key: 'referrals', icon: Users, label: t('strategyMetrics.referralCoefficient'), tint: 'text-blue-400 bg-blue-500/15', ...referralTile },
  ];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{t('strategyMetrics.whatTheProductIsJudgedOn')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('strategyMetrics.readLiveNothingIsStoredYet')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.key} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${tile.tint}`}>
              <tile.icon className="h-5 w-5" />
            </div>
            <div>
              <p className={toneClass(tile.tone)}>{tile.value}</p>
              <p className="mt-1 text-xs font-medium">{tile.label}</p>
              <p className="mt-0.5 text-xs text-muted">{tile.detail}</p>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
