'use client';

import { useState, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { ErrorState } from '@/components/ui/states';
import {
  Sun, Moon, CalendarDays, RefreshCw, Sparkles, AlertTriangle,
  CheckCircle2, Clock, X, Loader2, TrendingUp,
  ChevronRight, Star, Tv2, LayoutGrid,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { Database } from '@/lib/database.types';
import type { ConciergeDigest, ConciergeDomain, ConciergeUrgency } from '@/lib/concierge/digest';
import {
  briefingContextKey, createBriefingSession, purgeLegacyBriefingCache,
  type BriefingData, type BriefingResponse,
} from '@/lib/briefing/cache-isolation';
import { useTranslations } from '@/components/i18n/locale-provider';

// ─── Types ────────────────────────────────────────────────────────────────────

type OpsCategory = BriefingData['operationsScore']['categories'][number];

type TabType = 'morning' | 'evening' | 'weekly' | 'kitchen';
type CalEvent = Database['public']['Tables']['calendar_events']['Row'];
type ReminderRow = Database['public']['Tables']['reminders']['Row'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COLOR_CLASSES: Record<string, string> = {
  blue:    'bg-blue-500/20 text-blue-300 border-blue-500/30',
  purple:  'bg-purple-500/20 text-purple-300 border-purple-500/30',
  rose:    'bg-rose-500/20 text-rose-300 border-rose-500/30',
  emerald: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  amber:   'bg-amber-500/20 text-amber-300 border-amber-500/30',
  cyan:    'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  indigo:  'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
};
const DOT_CLASSES: Record<string, string> = {
  blue: 'bg-blue-400', purple: 'bg-purple-400', rose: 'bg-rose-400',
  emerald: 'bg-emerald-400', amber: 'bg-amber-400', cyan: 'bg-cyan-400', indigo: 'bg-indigo-400',
};
const STRESS_CONFIG = {
  low:      { label: 'Low Stress',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  moderate: { label: 'Moderate',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  high:     { label: 'High Stress', color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/20' },
};
const URGENCY_CLASSES = {
  high:   'text-rose-400 bg-rose-500/10 border-rose-500/30',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  low:    'text-muted bg-slate-500/10 border-slate-500/30',
};
const MEMBER_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#06b6d4'];

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreRing({ score, size = 110 }: { score: number; size?: number }) {
  const r = size * 0.4;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(100, Math.max(0, score)) / 100);
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#f43f5e';
  return (
    <svg width={size} height={size} className="rotate-[-90deg]">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={size * 0.09} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={size * 0.09}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
    </svg>
  );
}

function CategoryBar({ label, score, icon }: OpsCategory) {
  const barColor = score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-3">
      <span className="text-base w-6 text-center">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted truncate">{label}</span>
          <span className="text-xs font-semibold text-fg ml-2">{score}</span>
        </div>
        <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all duration-700', barColor)} style={{ width: `${score}%` }} />
        </div>
      </div>
    </div>
  );
}

const DOMAIN_META: Record<ConciergeDomain, { emoji: string; label: string; href: string }> = {
  bill:        { emoji: '💵', label: 'Bill',        href: '/dashboard/billing' },
  medication:  { emoji: '💊', label: 'Medication',  href: '/dashboard/medications' },
  maintenance: { emoji: '🔧', label: 'Maintenance', href: '/dashboard/home' },
  warranty:    { emoji: '🛡️', label: 'Warranty',    href: '/dashboard/home' },
  trip:        { emoji: '✈️', label: 'Trip',        href: '/dashboard/vacations' },
  pantry:      { emoji: '🥫', label: 'Pantry',      href: '/dashboard/pantry' },
};
const DIGEST_URGENCY: Record<ConciergeUrgency, { label: string; cls: string; dot: string }> = {
  overdue: { label: 'Overdue',   cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30',     dot: 'bg-rose-400' },
  today:   { label: 'Today',     cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30',   dot: 'bg-amber-400' },
  soon:    { label: 'Coming up', cls: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',      dot: 'bg-cyan-400' },
};

/**
 * The cross-domain "What needs attention today?" card — the heart of the AI
 * Concierge. Pulls deadline-bearing obligations from every domain (bills, meds,
 * home, warranties, trips, pantry) into one prioritized, deterministic answer.
 */
function NeedsAttention({ digest }: { digest: ConciergeDigest }) {
  const tr = useTranslations();
  const { counts, items, headline } = digest;
  return (
    <div className="rounded-2xl bg-gradient-to-br from-violet-500/10 to-indigo-500/[0.04] border border-violet-500/20 p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-violet-400" />
          <span className="text-sm font-semibold text-fg uppercase tracking-wider">{tr('briefing.needsAttentionToday')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {counts.overdue > 0 && <span className="text-xs px-2 py-0.5 rounded-full border text-rose-400 bg-rose-500/10 border-rose-500/30">{counts.overdue} overdue</span>}
          {counts.today > 0 && <span className="text-xs px-2 py-0.5 rounded-full border text-amber-400 bg-amber-500/10 border-amber-500/30">{counts.today} today</span>}
          {counts.soon > 0 && <span className="text-xs px-2 py-0.5 rounded-full border text-cyan-300 bg-cyan-500/10 border-cyan-500/30">{counts.soon} soon</span>}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-emerald-300 py-2">
          <CheckCircle2 className="h-4 w-4" /> {headline}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 8).map((item, i) => {
            const meta = DOMAIN_META[item.domain];
            const u = DIGEST_URGENCY[item.urgency];
            return (
              <li key={i}>
                <a href={meta.href}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 hover:bg-surface/70 transition-colors group">
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', u.dot)} />
                  <span className="text-base flex-shrink-0">{meta.emoji}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-fg block truncate">{item.title}</span>
                    <span className="text-xs text-muted block truncate">{item.detail}</span>
                  </span>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border flex-shrink-0', u.cls)}>{u.label}</span>
                  <ChevronRight className="h-4 w-4 text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 transition-opacity flex-shrink-0" />
                </a>
              </li>
            );
          })}
          {items.length > 8 && (
            <li className="text-xs text-muted text-center pt-1">+{items.length - 8} {tr('briefing.moreAcrossBillsHomeHealthAmp')}</li>
          )}
        </ul>
      )}
    </div>
  );
}

type AlsoTodayRow = NonNullable<BriefingResponse['alsoToday']>[number];

/**
 * "Also today" — the notifications that did not earn an interruption.
 *
 * These rows were classified 'digest' by lib/notifications/priority.ts, folded
 * in by `buildBrief` and marked read by the route that rendered them, so each
 * one is said exactly once: here, with a link to the thing it is about, instead
 * of once in the bell and again in the list.
 *
 * `unavailable` is the read-boundary case. If the notification queue could not
 * be read, this says so and stays retryable — it must never render as an empty
 * "nothing else today", which is a claim the failed read cannot support.
 */
function AlsoToday({ items, unavailable }: { items: AlsoTodayRow[]; unavailable: boolean }) {
  const tr = useTranslations();
  return (
    <div className="rounded-2xl border border-border bg-surface/30 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted" />
        <span className="text-sm font-semibold uppercase tracking-wider text-fg">{tr('briefing.alsoToday')}</span>
      </div>
      {unavailable ? (
        <p className="flex items-center gap-2 py-1 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {tr('briefing.alsoTodayUnavailable')}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 transition-colors hover:bg-surface/70"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
                    {item.detail && <span className="block truncate text-xs text-muted">{item.detail}</span>}
                  </span>
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">{tr('briefing.alsoTodayHint')}</p>
        </>
      )}
    </div>
  );
}

function GenerateCTA({ onGenerate, loading, type }: { onGenerate: () => void; loading: boolean; type: TabType }) {
  const tr = useTranslations();
  const cfg: Record<TabType, { icon: React.ReactNode; title: string; desc: string }> = {
    morning: { icon: <Sun className="h-8 w-8 text-amber-400" />,    title: 'Morning Briefing', desc: 'Start your day with a complete picture of what your family needs today.' },
    evening: { icon: <Moon className="h-8 w-8 text-indigo-400" />,  title: 'Evening Recap',   desc: 'Review what got done, what is outstanding, and preview tomorrow.' },
    weekly:  { icon: <CalendarDays className="h-8 w-8 text-emerald-400" />, title: 'Weekly Overview', desc: 'Get ahead of the week with conflicts flagged and suggestions ready.' },
    kitchen: { icon: <Tv2 className="h-8 w-8 text-cyan-400" />,     title: 'Kitchen Display', desc: 'Always-on display showing who is where and what is coming up.' },
  };
  const { icon, title, desc } = cfg[type];
  return (
    <div className="flex flex-col items-center justify-center py-24 px-8 text-center">
      <div className="w-20 h-20 rounded-2xl bg-surface/50 border border-border flex items-center justify-center mb-6">{icon}</div>
      <h2 className="text-2xl font-bold text-fg mb-3">{title}</h2>
      <p className="text-muted max-w-md mb-8">{desc}</p>
      <Button onClick={onGenerate} disabled={loading}
        className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white px-8 py-3 rounded-xl font-semibold text-base h-auto gap-2">
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
        {loading ? 'Generating…' : `Generate ${title}`}
      </Button>
      {loading && <p className="text-muted text-sm mt-4">{tr('briefing.analyzingYourFamilyDataWithAi')}</p>}
    </div>
  );
}

// ─── Morning Content ──────────────────────────────────────────────────────────

function MorningContent({ data, relationships }: { data: BriefingData; relationships?: React.ReactNode }) {
  const tr = useTranslations();
  const ops = data.operationsScore;
  const stress = ops?.stressLevel ? STRESS_CONFIG[ops.stressLevel] : STRESS_CONFIG.low;
  return (
    <div className="space-y-6">
      {/* Relationship reasoning (R2 — graph-backed) */}
      {relationships}
      {/* Ops Score */}
      {ops && (
        <div className="rounded-2xl bg-gradient-to-br from-white/5 to-white/[0.02] border border-border p-6">
          <div className="flex items-center gap-2 mb-5">
            <TrendingUp className="h-4 w-4 text-violet-400" />
            <span className="text-sm font-semibold text-fg uppercase tracking-wider">{tr('briefing.familyOperationsScore')}</span>
          </div>
          <div className="flex gap-8 items-center">
            <div className="relative flex-shrink-0">
              <ScoreRing score={ops.overall} size={110} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-fg">{ops.overall}</span>
                <span className="text-xs text-muted">/100</span>
              </div>
            </div>
            <div className="flex-1 space-y-3 min-w-0">
              {(ops.categories ?? []).map(cat => <CategoryBar key={cat.label} {...cat} />)}
            </div>
          </div>
          {(ops.stressReason || ops.recommendation) && (
            <div className="mt-5 pt-5 border-t border-border flex flex-col sm:flex-row gap-3">
              {ops.stressReason && (
                <div className={cn('flex-1 rounded-xl border px-4 py-3 text-sm', stress.bg)}>
                  <span className={cn('font-semibold', stress.color)}>{stress.label}: </span>
                  <span className="text-fg/80">{ops.stressReason}</span>
                </div>
              )}
              {ops.recommendation && (
                <div className="flex-1 rounded-xl border border-violet-500/20 bg-violet-500/10 px-4 py-3 text-sm">
                  <span className="font-semibold text-violet-400">{tr('briefing.aiTip')} </span>
                  <span className="text-fg/80">{ops.recommendation}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Schedule timeline */}
        <div className="lg:col-span-2 rounded-2xl bg-surface/50 border border-border p-5">
          <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-5 flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-400" /> {tr('briefing.todayAposSSchedule')}
          </h3>
          {data.schedule.length === 0 ? (
            <p className="text-muted text-sm py-8 text-center">{tr('briefing.noEventsScheduledEnjoyTheOpen')}</p>
          ) : (
            <div className="relative pl-5">
              <div className="absolute left-1.5 top-2 bottom-2 w-px bg-elevated" />
              <div className="space-y-5">
                {data.schedule.map((item, i) => (
                  <div key={i} className="flex gap-4 items-start">
                    <div className="relative -left-[1.375rem] mt-1.5 flex-shrink-0">
                      <div className={cn('w-3 h-3 rounded-full border-2 border-slate-900', DOT_CLASSES[item.color] ?? 'bg-slate-400')} />
                    </div>
                    <div className="flex-1 flex items-start justify-between gap-3 pb-5 border-b border-border last:border-0 last:pb-0">
                      <div>
                        <div className="text-xs text-muted mb-0.5">{item.time}</div>
                        <div className="text-sm font-medium text-fg">{item.emoji} {item.title}</div>
                        {item.member && <div className="text-xs text-muted mt-0.5">{item.member}</div>}
                      </div>
                      <span className={cn('text-xs px-2.5 py-0.5 rounded-full border flex-shrink-0 mt-0.5', COLOR_CLASSES[item.color] ?? COLOR_CLASSES.blue)}>
                        {item.member || 'Family'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Family Summary */}
          <div className="rounded-2xl bg-surface/50 border border-border p-5">
            <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3 flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-400" /> {tr('briefing.summary')}
            </h3>
            <ul className="space-y-2.5">
              {(data.familySummary ?? []).map((item, i) => (
                <li key={i} className="flex gap-2 text-sm text-fg/80">
                  <span className="text-violet-400 flex-shrink-0 mt-0.5">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Reminders */}
          {data.reminders.length > 0 && (
            <div className="rounded-2xl bg-surface/50 border border-border p-5">
              <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3">{tr('briefing.reminders')}</h3>
              <div className="space-y-2">
                {data.reminders.map((r, i) => (
                  <div key={i} className={cn('text-xs rounded-lg border px-3 py-2', URGENCY_CLASSES[r.urgency])}>
                    {r.urgency === 'high' && '⚠️ '}{r.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Conflicts */}
      {data.conflicts.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {tr('briefing.potentialConflicts')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {data.conflicts.map((c, i) => (
              <div key={i} className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4">
                <p className="text-sm text-amber-200 mb-3">{c.description}</p>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-emerald-300">{c.suggestion}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kids Needs */}
      {data.kidsNeeds.length > 0 && (
        <div className="rounded-2xl bg-surface/50 border border-border p-5">
          <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4">{tr('briefing.whatKidsNeedToday')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.kidsNeeds.map((kid, i) => (
              <div key={i} className="rounded-xl bg-surface/50 border border-border p-4">
                <div className="font-semibold text-fg mb-2">
                  {kid.name}
                  {kid.age != null && <span className="text-muted text-xs ml-1">(Age {kid.age})</span>}
                </div>
                <ul className="space-y-1.5">
                  {kid.items.map((item, j) => (
                    <li key={j} className="flex items-center gap-2 text-sm text-fg/80">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />{item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Meals */}
      {data.meals.length > 0 && (
        <div className="rounded-2xl bg-surface/50 border border-border p-5">
          <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4">{tr('briefing.meals')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {data.meals.map((meal, i) => (
              <div key={i} className={cn('rounded-xl border p-4', meal.status === 'planned' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-surface/50 border-border')}>
                <div className="text-xs text-muted mb-1">{meal.meal}</div>
                <div className="font-medium text-fg mb-2">
                  {meal.name ?? <span className="text-muted italic text-sm">{tr('briefing.notPlanned')}</span>}
                </div>
                {meal.missing && meal.missing.length > 0 && (
                  <div>
                    <div className="text-xs text-amber-400 mb-1">{tr('briefing.needToBuy')}</div>
                    {meal.missing.map((m, j) => <div key={j} className="text-xs text-muted">• {m}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Evening Content ──────────────────────────────────────────────────────────

function EveningContent({ data, recap }: { data: BriefingData; recap?: React.ReactNode }) {
  const tr = useTranslations();
  return (
    <div className="space-y-6">
      {recap}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl bg-emerald-500/5 border border-emerald-500/20 p-5">
          <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" /> {tr('briefing.completedToday')}
          </h3>
          {(data.completed ?? []).length === 0 ? (
            <p className="text-muted text-sm py-4">{tr('briefing.nothingLoggedYet')}</p>
          ) : (
            <ul className="space-y-2">
              {(data.completed ?? []).map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />{item}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl bg-amber-500/5 border border-amber-500/20 p-5">
          <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {tr('briefing.stillOutstanding')}
          </h3>
          {(data.outstanding ?? []).length === 0 ? (
            <p className="text-muted text-sm py-4">{tr('briefing.allClear')}</p>
          ) : (
            <ul className="space-y-2">
              {(data.outstanding ?? []).map((item, i) => (
                <li key={i} className={cn('text-sm px-3 py-2 rounded-lg border', URGENCY_CLASSES[item.urgency])}>
                  ⚠ {item.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {data.tomorrowPreview && (
        <div className="rounded-2xl bg-indigo-500/5 border border-indigo-500/20 p-5">
          <h3 className="text-sm font-semibold text-indigo-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <ChevronRight className="h-4 w-4" /> {tr('briefing.tomorrowPreview')} {data.tomorrowPreview.events} events
          </h3>
          <ul className="space-y-1.5">
            {(data.tomorrowPreview.notes ?? []).map((note, i) => (
              <li key={i} className="text-sm text-fg/80 flex gap-2">
                <span className="text-indigo-400">→</span>{note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Weekly Content ───────────────────────────────────────────────────────────

function WeeklyContent({ data }: { data: BriefingData }) {
  const tr = useTranslations();
  return (
    <div className="space-y-6">
      {(data.weeklyHighlights ?? []).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(data.weeklyHighlights ?? []).map((section, i) => (
            <div key={i} className="rounded-2xl bg-surface/50 border border-border p-5">
              <h3 className="font-semibold text-fg mb-3">{section.emoji} {section.category}</h3>
              <ul className="space-y-1.5">
                {section.items.map((item, j) => (
                  <li key={j} className="text-sm text-fg/80 flex gap-2">
                    <span className="text-violet-400 flex-shrink-0">•</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {(data.weeklyConflicts ?? []).length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {tr('briefing.schedulingConflictsThisWeek')}
          </h3>
          <div className="space-y-3">
            {(data.weeklyConflicts ?? []).map((c, i) => (
              <div key={i} className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4">
                <p className="text-sm text-amber-200 mb-2">{c.description}</p>
                <div className="flex gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-emerald-300">{c.suggestion}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Kitchen Mode ─────────────────────────────────────────────────────────────

function KitchenMode({ onExit, todayEvents, members, urgentReminders, now }: {
  onExit: () => void;
  todayEvents: CalEvent[];
  members: { id: string; display_name: string; role: string }[];
  urgentReminders: ReminderRow[];
  now: Date;
}) {
  const tr = useTranslations();
  function memberStatus(memberId: string): { label: string; active: boolean; next: boolean } {
    const current = todayEvents.find(e => {
      if (e.assignee_id !== memberId) return false;
      const start = new Date(e.starts_at);
      const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 60 * 60 * 1000);
      return start <= now && end > now;
    });
    if (current) return { label: current.title, active: true, next: false };
    const next = todayEvents.find(e => e.assignee_id === memberId && new Date(e.starts_at) > now);
    if (next) {
      const t = new Date(next.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return { label: `Next: ${next.title} at ${t}`, active: false, next: true };
    }
    return { label: 'Available', active: false, next: false };
  }

  const upcoming = todayEvents.filter(e => new Date(e.starts_at) > now).slice(0, 5);
  const clockStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayStr   = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="fixed inset-0 z-50 bg-[#07070d] flex flex-col overflow-hidden pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-fg" />
          </div>
          <span className="font-semibold text-fg text-lg">{tr('briefing.bubaly')}</span>
        </div>
        <div className="text-center">
          <div className="text-4xl font-bold text-fg tabular-nums tracking-tight">{clockStr}</div>
          <div className="text-sm text-muted mt-0.5">{dayStr}</div>
        </div>
        <button onClick={onExit} className="flex items-center gap-2 text-muted hover:text-fg transition-colors text-sm px-3 py-2 rounded-lg hover:bg-surface/50">
          <X className="h-4 w-4" /> {tr('briefing.exitKitchenMode')}
        </button>
      </div>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-2 overflow-hidden">
        {/* Left: Who is Where */}
        <div className="border-r border-border p-8 overflow-y-auto">
          <h2 className="text-xs font-bold text-muted uppercase tracking-widest mb-6">{tr('briefing.whoAposSWhereNow')}</h2>
          <div className="space-y-3">
            {members.map((m, i) => {
              const status = memberStatus(m.id);
              const hex = MEMBER_COLORS[i % MEMBER_COLORS.length];
              return (
                <div key={m.id} className={cn('rounded-2xl p-5 border transition-all', status.active ? 'border-border bg-surface/40' : 'border-border bg-surface/30')}>
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-bold text-fg flex-shrink-0"
                      style={{ backgroundColor: hex + '22', border: `2px solid ${hex}44` }}>
                      {m.display_name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-fg text-lg leading-tight">{m.display_name}</div>
                      <div className={cn('text-sm mt-1 truncate', status.active ? 'text-emerald-400' : status.next ? 'text-amber-400' : 'text-muted')}>
                        {status.label}
                      </div>
                    </div>
                    {status.active && <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Coming Up + Don't Forget */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex-1 p-8 overflow-y-auto">
            <h2 className="text-xs font-bold text-muted uppercase tracking-widest mb-6">{tr('briefing.comingUpToday')}</h2>
            {upcoming.length === 0 ? (
              <p className="text-muted text-xl font-medium">{tr('briefing.nothingMoreScheduledToday')}</p>
            ) : (
              <div className="space-y-3">
                {upcoming.map((e, i) => {
                  const t = new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                  return (
                    <div key={i} className="flex items-center gap-5 rounded-2xl bg-surface/40 border border-border p-5">
                      <div className="text-right min-w-[72px] flex-shrink-0">
                        <div className="text-2xl font-bold text-fg tabular-nums">{t.split(':')[0] + ':' + t.split(':')[1].split(' ')[0]}</div>
                        <div className="text-xs text-muted uppercase">{t.split(' ')[1]}</div>
                      </div>
                      <div className="w-px h-12 bg-elevated" />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-fg text-lg leading-tight truncate">{e.title}</div>
                        {e.location && <div className="text-sm text-muted mt-1">📍 {e.location}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {urgentReminders.length > 0 && (
            <div className="border-t border-amber-500/20 bg-amber-500/[0.04] px-8 py-5 flex-shrink-0">
              <h2 className="text-xs font-bold text-amber-600 uppercase tracking-widest mb-3">{tr('briefing.donAposTForget')}</h2>
              <div className="flex flex-wrap gap-2">
                {urgentReminders.map((r, i) => (
                  <span key={i} className="bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-full px-4 py-2 text-sm font-medium">
                    {r.title}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

type BriefingModuleProps = { recap?: React.ReactNode; relationships?: React.ReactNode };

export function BriefingModule(props: BriefingModuleProps = {}) {
  const tr = useTranslations();
  const context = useApp();
  const [tab, setTab] = useState<TabType>('morning');
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const contextKey = briefingContextKey(context, now.toISOString().slice(0, 10));

  useEffect(() => {
    try {
      purgeLegacyBriefingCache(window.sessionStorage);
    } catch { /* Access to sessionStorage itself may be blocked. */ }
  }, [contextKey]);

  if (!contextKey) {
    return <ErrorState message={tr('briefingModule.couldNotResolveYourCurrent')} />;
  }

  // A keyed boundary removes old content during rendering, before effect cleanup.
  return <ScopedBriefingModule key={contextKey} contextKey={contextKey} now={now} tab={tab} setTab={setTab} {...props} />;
}

function ScopedBriefingModule({ recap, relationships, contextKey, now, tab, setTab }: BriefingModuleProps & {
  contextKey: string;
  now: Date;
  tab: TabType;
  setTab: (tab: TabType) => void;
}) {
  const tr = useTranslations();
  const { familyId, members } = useApp();
  const [session] = useState(() => createBriefingSession());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const active = tab === 'kitchen' ? null : state[tab];
  const loading = active ? !active.attempted || active.loading : false;
  const error = active?.error ?? null;
  const currentBriefing = active?.data?.briefing ?? null;
  const generatedAt = active?.data?.generatedAt;
  const digest = active?.data?.digest;
  const alsoToday = active?.data?.alsoToday ?? [];
  const alsoTodayUnavailable = active?.data?.alsoTodayUnavailable ?? false;
  const generate = session.generate;
  const today = now.toISOString().slice(0, 10);

  useEffect(() => () => session.clear(), [session]);

  // Each tab gets one automatic attempt per mounted context. Failures stay retryable.
  useEffect(() => {
    if (tab === 'kitchen' || state[tab].attempted) return;
    void session.generate(tab);
  }, [session, state, tab]);

  // Live data for kitchen mode
  const { data: rawEvents, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<CalEvent>({
    table: 'calendar_events',
    familyId,
    deps: [contextKey],
    // rawEvents is only used for TODAY's events (filtered below + KitchenMode); the
    // weekly/tomorrow briefing data comes from a separate source. Bound to a small
    // window around today instead of loading the family's entire calendar history.
    fetcher: (sb) => sb.from('calendar_events').select('*').eq('family_id', familyId)
      .gte('starts_at', new Date(Date.now() - 86_400_000).toISOString())
      .lte('starts_at', new Date(Date.now() + 2 * 86_400_000).toISOString())
      .order('starts_at', { ascending: true }).limit(200) as never,
  });
  const { data: rawReminders, error: remindersError, refresh: refreshReminders } = useRealtimeQuery<ReminderRow>({
    table: 'reminders',
    familyId,
    deps: [contextKey],
    fetcher: (sb) => sb.from('reminders').select('*').eq('family_id', familyId).eq('is_done', false) as never,
  });

  const todayEvents = useMemo(() => {
    const list = (rawEvents ?? []) as CalEvent[];
    return list.filter(e => e.starts_at.slice(0, 10) === today).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [rawEvents, today]);
  const urgentReminders = useMemo(() => {
    const list = (rawReminders ?? []) as ReminderRow[];
    return list.filter(r => r.remind_at && r.remind_at.slice(0, 10) <= today).slice(0, 6);
  }, [rawReminders, today]);
  const kitchenError = eventsError || remindersError;
  const refreshKitchen = () => { void refreshEvents(); void refreshReminders(); };

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const TABS: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'morning', label: 'Morning',      icon: <Sun className="h-4 w-4" /> },
    { id: 'evening', label: 'Evening',      icon: <Moon className="h-4 w-4" /> },
    { id: 'weekly',  label: 'This Week',    icon: <CalendarDays className="h-4 w-4" /> },
    { id: 'kitchen', label: 'Kitchen Mode', icon: <Tv2 className="h-4 w-4" /> },
  ];

  // Kitchen mode renders fullscreen
  if (tab === 'kitchen') {
    if (kitchenError) return <ErrorState message={tr('briefingModule.couldNotLoadKitchenMode')} onRetry={refreshKitchen} />;
    return (
      <KitchenMode
        onExit={() => setTab('morning')}
        todayEvents={todayEvents}
        members={members}
        urgentReminders={urgentReminders}
        now={now}
      />
    );
  }

  const greetingEmoji = tab === 'morning' ? '☀️' : tab === 'evening' ? '🌙' : '📅';

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-violet-400" /> {tr('briefing.aiDailyBriefing')}
          </h1>
          <p className="text-muted text-sm mt-1">{tr('briefing.yourFamilyAposSChiefOf')}</p>
        </div>
        {currentBriefing && (
          <div className="flex items-center gap-3">
            {generatedAt && (
              <span className="text-xs text-muted">{tr('briefing.generated')} {fmtTime(generatedAt)}</span>
            )}
            <Button variant="outline" size="sm"
              onClick={() => generate(tab as Exclude<TabType, 'kitchen'>)}
              disabled={loading}
              className="border-border hover:bg-elevated text-fg/80 gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> {tr('briefing.refresh')}
            </Button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-surface/50 rounded-xl p-1 border border-border w-fit flex-wrap">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
              tab === t.id ? 'bg-violet-600 text-white shadow-lg' : 'text-muted hover:text-white hover:bg-surface/50',
            )}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">{error}</div>
      )}

      {/* Content area */}
      {!currentBriefing ? (
        <GenerateCTA onGenerate={() => generate(tab as Exclude<TabType, 'kitchen'>)} loading={loading} type={tab} />
      ) : (
        <div>
          {/* Greeting banner */}
          <div className="rounded-2xl bg-gradient-to-r from-violet-900/60 to-indigo-900/60 border border-violet-500/20 p-6 mb-6">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-2xl font-bold text-fg mb-1">{greetingEmoji} {currentBriefing.greeting}</div>
                <div className="text-fg/80 text-sm">{currentBriefing.subtitle}</div>
              </div>
              <LayoutGrid className="h-8 w-8 text-violet-400/30 flex-shrink-0 mt-1" />
            </div>
          </div>

          {/* Cross-domain concierge: "What does my family need to do today?" */}
          {digest && <div className="mb-6"><NeedsAttention digest={digest} /></div>}

          {/* The overnight recap belongs to the morning too — "since yesterday"
              read at 7am is what changed while the family slept, which is the
              whole point of the brief. It used to render only under Evening,
              and the tab defaults to Morning, so a parent who opened the brief
              to start the day saw none of what Bubaly had done. */}
          {tab === 'morning' && recap && <div className="mb-6">{recap}</div>}
          {tab === 'morning' && <MorningContent data={currentBriefing} relationships={relationships} />}
          {tab === 'evening' && <EveningContent data={currentBriefing} recap={recap} />}
          {tab === 'weekly'  && <WeeklyContent  data={currentBriefing} />}

          {/* Last, and deliberately: the quiet notifications are the part you
              are allowed to skim past. The weekly tab does not fold them — its
              window is a different one. */}
          {tab !== 'weekly' && (alsoToday.length > 0 || alsoTodayUnavailable) && (
            <div className="mt-6"><AlsoToday items={alsoToday} unavailable={alsoTodayUnavailable} /></div>
          )}
        </div>
      )}
    </div>
  );
}
