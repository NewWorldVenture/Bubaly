'use client';

// Trust Center → Activity (M24): what Bubaly DID, what it MAY do, and what it
// was allowed to READ — the three things the permissions console beside it
// could never say.
//
// Everything on this tab is read from persisted state by `lib/trust/activity.ts`:
// the ledger rows are `ai_tool_calls`, the dials are `family_ai_settings`, and
// the read/withheld lists are the slice names of `ai_request_context`. Nothing
// here is computed from what Bubaly was ASKED to do — an intention is not an
// action, and a tab that blurred the two would be worse than no tab.
//
// A failed read renders the retryable error state, never an empty ledger: "you
// have nothing to review" and "we could not check" are opposite answers, and
// only one of them is safe to show a family.
//
// This file is deliberately standalone (one mount line in `trust-module.tsx`)
// so the tabs beside it can change without touching it.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity, AlertTriangle, Check, ChevronRight, Eye, EyeOff, Lock, Scale, Sliders, X,
} from 'lucide-react';
import { ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import { DOMAIN_LABELS } from '@/lib/trust/engine';
import { useTranslations } from '@/components/i18n/locale-provider';
import { sliceLabel, sliceLabelKey } from '@/lib/trust/slice-labels';
import type { TrustActivity, TrustToolCall } from '@/lib/trust/activity';

/** The policy columns this tab needs to show a dial beside the rules for the same domain. */
export type ActivityPolicy = { domain: string; enabled: boolean };

const BEHAVIOR_KEYS: Record<string, string> = {
  recommend: 'trustActivity.behaviorRecommend',
  prepare: 'trustActivity.behaviorPrepare',
  execute: 'trustActivity.behaviorExecute',
};

const STATE_KEYS: Record<string, string> = {
  succeeded: 'trustActivity.stateSucceeded',
  failed: 'trustActivity.stateFailed',
  reserved: 'trustActivity.stateStarted',
};

const STATE_STYLES: Record<string, string> = {
  succeeded: 'text-green-400',
  failed: 'text-red-400',
  reserved: 'text-amber-400',
};

const ACTOR_KEYS: Record<string, string> = {
  ai: 'trustActivity.actorBubaly',
  member: 'trustActivity.actorMember',
  system: 'trustActivity.actorAutomatic',
};

function fmtWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function TrustActivityTab({
  activity,
  error,
  policies,
}: {
  activity: TrustActivity | null;
  /** Already-translated copy for a failed read; when set nothing else renders. */
  error: string | null;
  policies: ActivityPolicy[];
}) {
  const tr = useTranslations();
  const router = useRouter();

  // Fail closed. An empty ledger and a ledger nobody could read must not look
  // the same — see lib/trust/activity.ts.
  if (error || !activity) {
    return <ErrorState message={error ?? tr('trustActivity.couldNotLoadActivity')} onRetry={() => router.refresh()} />;
  }

  const policyCountFor = (domain: string) => policies.filter((p) => p.domain === domain && p.enabled).length;

  return (
    <div className="space-y-6">
      <Section
        icon={Activity}
        title={tr('trustActivity.whatBubalyDid')}
        sub={tr('trustActivity.everyActionRecordedWhenItRan')}
      >
        {activity.toolCalls.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/30 px-4 py-6 text-center text-xs text-muted">
            {tr('trustActivity.nothingRecordedYet')}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-2xl border border-border bg-surface/30 divide-y divide-border/50">
            {activity.toolCalls.map((call) => <ToolCallRow key={call.id} call={call} />)}
          </ul>
        )}
        {activity.hiddenToolCalls > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Lock className="h-3 w-3" aria-hidden />
            {tr('trustActivity.entriesOnlyShownToParents', { count: activity.hiddenToolCalls })}
          </p>
        )}
      </Section>

      <Section
        icon={Sliders}
        title={tr('trustActivity.whatBubalyMayDoOnItsOwn')}
        sub={tr('trustActivity.dialsAreSetInSettings')}
      >
        {!activity.dials.enabled && (
          <p className="mb-2 flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {tr('trustActivity.autonomousWorkIsOff')}
          </p>
        )}
        <ul className="overflow-hidden rounded-2xl border border-border bg-surface/30 divide-y divide-border/50">
          {activity.dials.categories.map((dial) => {
            const count = policyCountFor(dial.domain);
            return (
              <li key={dial.domain} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{DOMAIN_LABELS[dial.domain] ?? dial.domain}</span>
                <span className="flex items-center gap-1 text-[10px] text-muted">
                  <Scale className="h-3 w-3" aria-hidden />
                  {count === 1 ? tr('trustActivity.onePolicy') : tr('trustActivity.nPolicies', { count })}
                </span>
                <span className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                  dial.inherited ? 'border-border bg-surface text-muted' : 'border-brand/30 bg-brand/10 text-brand-text',
                )}>
                  {tr(BEHAVIOR_KEYS[dial.behavior] ?? BEHAVIOR_KEYS.execute)}
                </span>
              </li>
            );
          })}
        </ul>
        <Link
          href="/dashboard/settings"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-brand-text hover:underline"
        >
          {tr('trustActivity.changeTheseInSettings')} <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </Section>

      <Section
        icon={Eye}
        title={tr('trustActivity.whatBubalyRead')}
        sub={tr('trustActivity.namesOfWhatItLookedAtNeverContents')}
      >
        {!activity.canSeeContext ? (
          <p className="flex items-center gap-1.5 rounded-2xl border border-border bg-surface/30 px-4 py-6 text-center text-xs text-muted">
            <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {tr('trustActivity.readHistoryIsForParents')}
          </p>
        ) : activity.contextReads.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/30 px-4 py-6 text-center text-xs text-muted">
            {tr('trustActivity.noRequestsHaveNeededContext')}
          </p>
        ) : (
          <ul className="space-y-2">
            {activity.contextReads.map((entry) => (
              <li key={entry.requestId} className="rounded-2xl border border-border bg-surface/30 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-xs font-medium text-fg/90">
                    {entry.requestText || tr('trustActivity.aRequestFromYourFamily')}
                  </p>
                  <span className="flex-shrink-0 text-[10px] text-muted">{fmtWhen(entry.createdAt)}</span>
                </div>
                <SliceList
                  icon={Eye}
                  label={tr('trustActivity.read')}
                  slices={entry.read}
                  empty={tr('trustActivity.nothing')}
                  tone="text-fg/70"
                />
                <SliceList
                  icon={EyeOff}
                  label={tr('trustActivity.withheld')}
                  slices={entry.withheld}
                  empty={tr('trustActivity.nothingWithheld')}
                  tone="text-amber-300/80"
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  icon: Icon, title, sub, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-text" aria-hidden />
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
          <p className="mt-0.5 text-[11px] text-muted">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function ToolCallRow({ call }: { call: TrustToolCall }) {
  const tr = useTranslations();
  const stateKey = STATE_KEYS[call.state] ?? STATE_KEYS.reserved;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={cn('mt-0.5 flex-shrink-0 text-[11px] font-bold', STATE_STYLES[call.state] ?? 'text-muted')}>
        {call.state === 'succeeded' ? <Check className="h-3.5 w-3.5" aria-hidden /> : call.state === 'failed' ? <X className="h-3.5 w-3.5" aria-hidden /> : <Activity className="h-3.5 w-3.5" aria-hidden />}
        <span className="sr-only">{tr(stateKey)}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-fg/90">{call.toolName}</p>
        <p className="mt-0.5 text-[10px] text-muted">
          {call.domain ? `${DOMAIN_LABELS[call.domain] ?? call.domain} · ` : ''}
          {tr(ACTOR_KEYS[call.actorKind] ?? ACTOR_KEYS.ai)}
          {` · ${fmtWhen(call.createdAt)}`}
        </p>
        {call.state === 'failed' && call.error && (
          <p className="mt-0.5 text-[10px] text-red-400">{call.error}</p>
        )}
      </div>
      {call.runId && (
        <Link
          href={`/dashboard/concierge/runs/${call.runId}`}
          className="flex-shrink-0 text-[11px] font-medium text-brand-text hover:underline"
        >
          {tr('trustActivity.openRun')}
        </Link>
      )}
    </li>
  );
}

/** Slice NAMES, never their contents — see lib/trust/activity.ts. */
function SliceList({
  icon: Icon, label, slices, empty, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  slices: string[];
  empty: string;
  tone: string;
}) {
  const tr = useTranslations();
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className="flex items-center gap-1 font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-3 w-3" aria-hidden /> {label}
      </span>
      {slices.length === 0 ? (
        <span className="text-muted">{empty}</span>
      ) : (
        slices.map((slice) => {
          const key = sliceLabelKey(slice);
          return (
            <span key={slice} className={cn('rounded-md border border-border bg-surface px-1.5 py-0.5', tone)}>
              {key ? tr(key) : sliceLabel(slice)}
            </span>
          );
        })
      )}
    </div>
  );
}
