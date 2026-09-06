'use client';

// Specialized agents behind one interface (North Star pillar #6). The family
// sees one assistant; this surface shows the Chief of Staff's synthesis, the
// roster of specialists with live status, and each agent's briefing + its recent
// activity from the durable log (which the family can act on / dismiss).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Compass, Calendar, UtensilsCrossed, Wallet, Home, GraduationCap, HeartPulse,
  Plane, Cake, Inbox, ArrowRight, Check, X, CircleDot, Sparkles,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { resolveActivityAction } from '@/app/(app)/dashboard/agents/actions';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { AGENTS, AGENTS_BY_ID, type AgentId, type AgentBriefing, type AgentStatus } from '@/lib/agents/roster';
import { WhyThis } from '@/components/ai/why-this';
import { explainAgentActivity } from '@/lib/ai/explanation';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Activity = Tables<'agent_activity'>;

const ICON: Record<string, typeof Compass> = {
  compass: Compass, calendar: Calendar, utensils: UtensilsCrossed, wallet: Wallet,
  home: Home, graduation: GraduationCap, 'heart-pulse': HeartPulse, plane: Plane,
  cake: Cake, inbox: Inbox,
};
const STATUS_DOT: Record<AgentStatus, string> = {
  action: 'bg-rose-500', attention: 'bg-amber-400', clear: 'bg-emerald-500',
};
const SEV_STYLE = {
  action: 'text-rose-300', attention: 'text-amber-300', info: 'text-muted',
} as const;

export function AgentsModule({ briefings, activity }: { briefings: AgentBriefing[]; activity: Activity[] }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [selected, setSelected] = useState<AgentId>('scheduler');
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const byId = useMemo(() => new Map(briefings.map((b) => [b.agentId, b])), [briefings]);
  const chief = byId.get('chief_of_staff');
  const specialists = AGENTS.filter((a) => a.id !== 'chief_of_staff');
  const selectedBriefing = byId.get(selected);
  const selectedAgent = AGENTS_BY_ID[selected];

  const activityByAgent = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of activity) {
      if (hidden.has(a.id)) continue;
      const arr = m.get(a.agent) ?? [];
      arr.push(a); m.set(a.agent, arr);
    }
    return m;
  }, [activity, hidden]);

  async function resolve(a: Activity, status: 'done' | 'dismissed') {
    setHidden((h) => new Set(h).add(a.id));
    const res = await resolveActivityAction(a.id, status);
    if (!res.ok) { toastError(res.error); setHidden((h) => { const n = new Set(h); n.delete(a.id); return n; }); return; }
    success(status === 'done' ? 'Marked done' : 'Dismissed');
  }

  const SelIcon = ICON[selectedAgent.icon] ?? Sparkles;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title={t('agents.yourFamilyAssistant')}
        description="One assistant, a team of specialists behind it — each watching its corner of family life."
      />

      {/* Chief of Staff synthesis */}
      {chief && (
        <div className={cn('mb-6 rounded-2xl border p-5',
          chief.status === 'action' ? 'border-rose-500/30 bg-rose-500/5'
            : chief.status === 'attention' ? 'border-amber-500/30 bg-amber-500/5'
            : 'border-emerald-500/30 bg-emerald-500/5')}>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-surface text-brand-text"><Compass className="h-5 w-5" /></span>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('agents.chiefOfStaff')}</h2>
              <p className="text-xs text-muted">{AGENTS_BY_ID.chief_of_staff.role}</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-fg">{chief.headline}</p>
          {chief.items.length > 0 && (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {chief.items.map((it, i) => (
                <li key={i}>
                  <Link href={it.href} className="flex items-center gap-2 rounded-xl border border-border bg-bg/40 px-3 py-2 text-xs transition hover:border-brand/40 hover:bg-elevated">
                    <CircleDot className={cn('h-3.5 w-3.5 shrink-0', SEV_STYLE[it.severity])} />
                    <span className="min-w-0 flex-1 truncate text-fg">{it.title}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        {/* Specialist roster */}
        <div className="grid grid-cols-2 gap-3 self-start sm:grid-cols-3 lg:grid-cols-2">
          {specialists.map((a) => {
            const b = byId.get(a.id);
            const Icon = ICON[a.icon] ?? Sparkles;
            const active = a.id === selected;
            const attn = (b?.items.filter((i) => i.severity !== 'info').length) ?? 0;
            return (
              <button key={a.id} onClick={() => setSelected(a.id)}
                className={cn('relative flex flex-col gap-2 rounded-2xl border p-3 text-left transition',
                  active ? 'border-brand bg-brand/5 ring-1 ring-brand/40' : 'border-border bg-surface/50 hover:bg-elevated')}>
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-border text-fg"><Icon className="h-4 w-4" /></span>
                  {b && <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[b.status])} />}
                </div>
                <span className="text-xs font-semibold text-fg">{a.name}</span>
                {attn > 0 && <span className="absolute right-2 top-2 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1 text-[11px] font-bold text-white">{attn}</span>}
              </button>
            );
          })}
        </div>

        {/* Selected agent detail */}
        {selectedBriefing && (
          <div className="rounded-2xl border border-border bg-surface/50 p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-border text-brand-text"><SelIcon className="h-5 w-5" /></span>
              <div>
                <h2 className="text-lg font-bold text-fg">{selectedAgent.name}</h2>
                <p className="text-xs text-muted">{selectedAgent.role}</p>
              </div>
            </div>

            <p className="mt-3 text-sm text-fg">{selectedBriefing.headline}</p>

            {selectedBriefing.items.length > 0 && (
              <ul className="mt-3 space-y-2">
                {selectedBriefing.items.map((it, i) => (
                  <li key={i}>
                    <Link href={it.href} className="group flex items-center gap-3 rounded-xl border border-border bg-bg/40 p-3 transition hover:border-brand/40 hover:bg-elevated">
                      <CircleDot className={cn('h-4 w-4 shrink-0', SEV_STYLE[it.severity])} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg">{it.title}</p>
                        <p className="truncate text-xs text-muted">{it.detail}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {/* Recent activity from the durable log */}
            {(() => {
              const acts = activityByAgent.get(selected) ?? [];
              if (acts.length === 0) return null;
              return (
                <div className="mt-5">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent activity</h3>
                  <ul className="space-y-2">
                    {acts.slice(0, 8).map((a) => (
                      <li key={a.id} className="rounded-xl border border-border bg-bg/30 p-2.5">
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-fg">{a.title}</p>
                            {a.detail && <p className="truncate text-xs text-muted">{a.detail}</p>}
                          </div>
                          {a.href && <Link href={a.href} className="rounded-lg p-1.5 text-muted hover:text-brand-text" aria-label="Open"><ArrowRight className="h-4 w-4" /></Link>}
                          <button onClick={() => resolve(a, 'done')} aria-label="Mark done" className="rounded-lg p-1.5 text-muted hover:text-emerald-300"><Check className="h-4 w-4" /></button>
                          <button onClick={() => resolve(a, 'dismissed')} aria-label="Dismiss" className="rounded-lg p-1.5 text-muted hover:text-rose-400"><X className="h-4 w-4" /></button>
                        </div>
                        <div className="mt-1.5">
                          <WhyThis
                            surface="agent" refId={a.id} refKind={a.agent}
                            explanation={explainAgentActivity({ agent: a.agent, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity })}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
