'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  CalendarDays, RefreshCw, Sparkles, AlertTriangle, CheckCircle2,
  Loader2, TrendingUp, Trophy, History, ListTodo, Target, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

// ─── Types (mirror the /api/ai/weekly-briefing JSON contract) ──────────────────

interface DayPlan {
  day: string;
  date: string;
  emoji: string;
  load: 'light' | 'moderate' | 'heavy';
  events: { time: string; title: string; member?: string }[];
}
interface Highlight { category: string; emoji: string; items: string[] }
interface Conflict { description: string; suggestion: string }
interface PrepItem { text: string; for?: string }
interface OpsCategory { label: string; score: number; icon: string }
interface WeeklyBriefingData {
  weekRange: string;
  headline: string;
  summary: string[];
  recap: {
    choreCompletion: number;
    wins: string[];
    misses: string[];
    note: string;
  };
  dayByDay: DayPlan[];
  highlights: Highlight[];
  conflicts: Conflict[];
  prepChecklist: PrepItem[];
  weeklyScore: {
    overall: number;
    categories: OpsCategory[];
    stressLevel: 'low' | 'moderate' | 'high';
    stressReason: string | null;
    focus: string;
  };
  focusOfTheWeek: string;
}

// ─── Style maps ────────────────────────────────────────────────────────────────

const LOAD_CONFIG: Record<DayPlan['load'], { label: string; cls: string; dot: string }> = {
  light:    { label: 'Light',    cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', dot: 'bg-emerald-400' },
  moderate: { label: 'Moderate', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20',       dot: 'bg-amber-400' },
  heavy:    { label: 'Heavy',    cls: 'text-rose-400 bg-rose-500/10 border-rose-500/20',           dot: 'bg-rose-400' },
};
const STRESS_CONFIG = {
  low:      { label: 'Low Stress',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  moderate: { label: 'Moderate',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  high:     { label: 'High Stress', color: 'text-rose-400',    bg: 'bg-rose-500/10 border-rose-500/20' },
};

// ─── Sub-components ────────────────────────────────────────────────────────────

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

function GenerateCTA({ onGenerate, loading }: { onGenerate: () => void; loading: boolean }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center justify-center py-24 px-8 text-center">
      <div className="w-20 h-20 rounded-2xl bg-surface/50 border border-border flex items-center justify-center mb-6">
        <CalendarDays className="h-8 w-8 text-emerald-400" />
      </div>
      <h2 className="text-2xl font-bold text-fg mb-3">{t('weeklyBriefing.weeklyAiBriefing')}</h2>
      <p className="text-muted max-w-md mb-8">{t('weeklyBriefingModule.lookBackAtHowLast')}</p>
      <Button onClick={onGenerate} disabled={loading}
        className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white px-8 py-3 rounded-xl font-semibold text-base h-auto gap-2">
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
        {loading ? 'Planning your week…' : 'Generate Weekly Briefing'}
      </Button>
      {loading && <p className="text-muted text-sm mt-4">{t('weeklyBriefing.analyzingLastWeekAndTheWeek')}</p>}
    </div>
  );
}

// ─── Main content ──────────────────────────────────────────────────────────────

function WeeklyContent({ data }: { data: WeeklyBriefingData }) {
  const t = useTranslations();
  const ops = data.weeklyScore;
  const stress = ops?.stressLevel ? STRESS_CONFIG[ops.stressLevel] : STRESS_CONFIG.low;
  const recap = data.recap;

  return (
    <div className="space-y-6">
      {/* Weekly Ops Score */}
      {ops && (
        <div className="rounded-2xl bg-gradient-to-br from-white/5 to-white/[0.02] border border-border p-6">
          <div className="flex items-center gap-2 mb-5">
            <TrendingUp className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-semibold text-fg uppercase tracking-wider">{t('weeklyBriefing.weekReadinessScore')}</span>
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
              {(ops.categories ?? []).map((cat) => <CategoryBar key={cat.label} {...cat} />)}
            </div>
          </div>
          {(ops.stressReason || ops.focus) && (
            <div className="mt-5 pt-5 border-t border-border flex flex-col sm:flex-row gap-3">
              {ops.stressReason && (
                <div className={cn('flex-1 rounded-xl border px-4 py-3 text-sm', stress.bg)}>
                  <span className={cn('font-semibold', stress.color)}>{stress.label}: </span>
                  <span className="text-fg/80">{ops.stressReason}</span>
                </div>
              )}
              {ops.focus && (
                <div className="flex-1 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm">
                  <span className="font-semibold text-emerald-400">Focus: </span>
                  <span className="text-fg/80">{ops.focus}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Last week recap */}
      {recap && (
        <div className="rounded-2xl bg-surface/50 border border-border p-5">
          <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4 flex items-center gap-2">
            <History className="h-4 w-4 text-indigo-400" /> {t('weeklyBriefing.lastWeekRecap')}
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr_1fr] gap-5 items-start">
            <div className="rounded-xl bg-indigo-500/5 border border-indigo-500/20 px-5 py-4 text-center">
              <div className="text-3xl font-bold text-indigo-300">{recap.choreCompletion}%</div>
              <div className="text-xs text-muted mt-1">{t('weeklyBriefing.choresDone')}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Trophy className="h-3.5 w-3.5" /> {t('weeklyBriefing.wins')}
              </div>
              {(recap.wins ?? []).length === 0 ? (
                <p className="text-muted text-sm">{t('weeklyBriefing.nothingLogged')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {recap.wins.map((wIt, i) => (
                    <li key={i} className="flex gap-2 text-sm text-fg/80">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0 mt-0.5" />{wIt}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> {t('weeklyBriefing.slipped')}
              </div>
              {(recap.misses ?? []).length === 0 ? (
                <p className="text-muted text-sm">{t('weeklyBriefing.allClear')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {recap.misses.map((m, i) => (
                    <li key={i} className="flex gap-2 text-sm text-fg/80">
                      <span className="text-amber-400 flex-shrink-0">•</span>{m}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {recap.note && (
            <p className="mt-4 pt-4 border-t border-border text-sm text-indigo-200/80 italic">{recap.note}</p>
          )}
        </div>
      )}

      {/* Day by day */}
      {(data.dayByDay ?? []).length > 0 && (
        <div className="rounded-2xl bg-surface/50 border border-border p-5">
          <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-400" /> {t('weeklyBriefing.theWeekAhead')}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {data.dayByDay.map((d, i) => {
              const load = LOAD_CONFIG[d.load] ?? LOAD_CONFIG.light;
              return (
                <div key={i} className="rounded-xl bg-surface/40 border border-border p-4 flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="font-semibold text-fg leading-tight">{d.emoji} {d.day}</div>
                      <div className="text-xs text-muted">{d.date}</div>
                    </div>
                    <span className={cn('text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1', load.cls)}>
                      <span className={cn('w-1.5 h-1.5 rounded-full', load.dot)} />{load.label}
                    </span>
                  </div>
                  {(d.events ?? []).length === 0 ? (
                    <p className="text-xs text-muted py-2">{t('weeklyBriefing.openDay')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {d.events.map((ev, j) => (
                        <li key={j} className="text-xs">
                          <div className="text-muted tabular-nums">{ev.time}</div>
                          <div className="text-fg/90 font-medium leading-tight">{ev.title}</div>
                          {ev.member && <div className="text-muted">{ev.member}</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Highlights */}
      {(data.highlights ?? []).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.highlights.map((section, i) => (
            <div key={i} className="rounded-2xl bg-surface/50 border border-border p-5">
              <h3 className="font-semibold text-fg mb-3">{section.emoji} {section.category}</h3>
              <ul className="space-y-1.5">
                {section.items.map((item, j) => (
                  <li key={j} className="text-sm text-fg/80 flex gap-2">
                    <span className="text-emerald-400 flex-shrink-0">•</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Conflicts */}
        {(data.conflicts ?? []).length > 0 && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
            <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {t('weeklyBriefing.conflictsThisWeek')}
            </h3>
            <div className="space-y-3">
              {data.conflicts.map((c, i) => (
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

        {/* Prep checklist */}
        {(data.prepChecklist ?? []).length > 0 && (
          <div className="rounded-2xl bg-surface/50 border border-border p-5">
            <h3 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4 flex items-center gap-2">
              <ListTodo className="h-4 w-4 text-violet-400" /> {t('weeklyBriefing.getAheadPrepChecklist')}
            </h3>
            <ul className="space-y-2">
              {data.prepChecklist.map((p, i) => (
                <li key={i} className="flex items-start gap-3 rounded-lg bg-surface/40 border border-border px-3 py-2.5">
                  <CheckCircle2 className="h-4 w-4 text-violet-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-fg/90">{p.text}</span>
                    {p.for && <span className="text-xs text-muted ml-2">for {p.for}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Focus of the week */}
      {data.focusOfTheWeek && (
        <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-900/30 to-teal-900/30 p-5 flex items-start gap-3">
          <Target className="h-5 w-5 text-emerald-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">{t('weeklyBriefing.focusOfTheWeek')}</div>
            <p className="text-sm text-fg/90">{data.focusOfTheWeek}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

export function WeeklyBriefingModule() {
  const t = useTranslations();
  const [data, setData] = useState<WeeklyBriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  // Cache key is the Monday-agnostic look-ahead start (today's UTC date) so a
  // generated briefing persists across the day without re-billing the AI call.
  const weekKey = new Date().toISOString().slice(0, 10);
  const storageKey = `fos_weekly_briefing_${weekKey}`;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { briefing: WeeklyBriefingData; at: string };
        setData(parsed.briefing);
        setGeneratedAt(parsed.at);
      }
    } catch { /* ignore */ }
  }, [storageKey]);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/weekly-briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 402) throw new Error('Weekly AI Briefing is a Family+ feature.');
      if (!res.ok) throw new Error('Failed to generate weekly briefing');
      const { briefing, generatedAt: at } = await res.json() as { briefing: WeeklyBriefingData; generatedAt: string };
      setData(briefing);
      setGeneratedAt(at);
      try { sessionStorage.setItem(storageKey, JSON.stringify({ briefing, at })); } catch { /* ignore */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('weeklyBriefingModule.somethingWentWrong'));
    } finally {
      setLoading(false);
    }
  }, [storageKey, t]);

  const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg flex items-center gap-2">
            <CalendarDays className="h-6 w-6 text-emerald-400" /> {t('weeklyBriefing.weeklyAiBriefing')}
          </h1>
          <p className="text-muted text-sm mt-1">
            {t('weeklyBriefing.reflectOnLastWeekAndPlan')}
            {data?.weekRange ? ` · ${data.weekRange}` : ''}
          </p>
        </div>
        {data && (
          <div className="flex items-center gap-3">
            {generatedAt && <span className="text-xs text-muted">{t('weeklyBriefing.generated')} {fmtTime(generatedAt)}</span>}
            <Button variant="outline" size="sm" onClick={generate} disabled={loading}
              className="border-border hover:bg-elevated text-fg/80 gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> {t('weeklyBriefing.refresh')}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">{error}</div>
      )}

      {!data ? (
        <GenerateCTA onGenerate={generate} loading={loading} />
      ) : (
        <div>
          {/* Headline banner */}
          <div className="rounded-2xl bg-gradient-to-r from-emerald-900/50 to-teal-900/50 border border-emerald-500/20 p-6 mb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-2xl font-bold text-fg mb-1">📅 {data.headline}</div>
                <div className="text-fg/80 text-sm">{data.weekRange}</div>
              </div>
              <Sparkles className="h-8 w-8 text-emerald-400/30 flex-shrink-0 mt-1" />
            </div>
            {(data.summary ?? []).length > 0 && (
              <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {data.summary.map((sIt, i) => (
                  <li key={i} className="flex gap-2 text-sm text-fg/80">
                    <span className="text-emerald-400 flex-shrink-0 mt-0.5">•</span>{sIt}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <WeeklyContent data={data} />
        </div>
      )}
    </div>
  );
}
