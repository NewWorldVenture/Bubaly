'use client';

// Design for Calm (North Star pillar #8). One quiet, prioritized surface: a
// gentle digest, only-what-needs-you up top, today's few things next, and
// everything else deliberately kept out of the way. Reduces mental load — it
// does not maximize engagement.
import { useState } from 'react';
import Link from 'next/link';
import {
  Leaf, AlertCircle, Sun, ArrowRight, CheckCircle2, Bot, Gauge, Inbox, Bell, ChevronDown, Network,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { CalmInbox, CalmItem, CalmSource } from '@/lib/calm/inbox';

const SOURCE_ICON: Record<CalmSource, typeof Bot> = {
  agent: Bot, autopilot: Sun, operating_index: Gauge, approval: Inbox, reminder: Bell, graph: Network,
};
const SOURCE_LABEL: Record<CalmSource, string> = {
  agent: 'Assistant', autopilot: 'Autopilot', operating_index: 'Operating Index', approval: 'Approval', reminder: 'Reminder', graph: 'Relationships',
};

function Row({ item, urgent }: { item: CalmItem; urgent?: boolean }) {
  const Icon = SOURCE_ICON[item.source];
  const inner = (
    <div className={cn('group flex items-center gap-3 rounded-xl border p-3 transition',
      urgent ? 'border-rose-500/30 bg-rose-500/5 hover:border-rose-500/50' : 'border-border bg-surface/50 hover:border-brand/40 hover:bg-elevated')}>
      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border', urgent ? 'text-rose-300' : 'text-muted')}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{item.title}</p>
        {item.detail && <p className="truncate text-xs text-muted">{item.detail}</p>}
      </div>
      <span className="hidden shrink-0 text-[10px] uppercase tracking-wide text-muted sm:block">{SOURCE_LABEL[item.source]}</span>
      {item.href && <ArrowRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />}
    </div>
  );
  return item.href ? <Link href={item.href}>{inner}</Link> : inner;
}

export function CalmModule({ inbox }: { inbox: CalmInbox }) {
  const [showQuiet, setShowQuiet] = useState(false);
  const allClear = inbox.needsYou.length === 0 && inbox.today.length === 0;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Calm"
        description="One quiet inbox. Only what needs you — everything else is handled in the background."
      />

      {/* Daily digest */}
      <div className={cn('mb-6 flex items-start gap-3 rounded-2xl border p-5',
        allClear ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-surface/50')}>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', allClear ? 'bg-emerald-500/15 text-emerald-300' : 'bg-brand/10 text-brand')}>
          <Leaf className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Today’s digest</p>
          <p className="mt-0.5 text-sm text-fg">{inbox.digest}</p>
        </div>
      </div>

      {allClear ? (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-surface/40 py-12 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-400/70" />
          <p className="mt-3 text-sm font-medium text-fg">You’re all caught up.</p>
          <p className="mt-1 max-w-xs text-xs text-muted">Bubaly is watching quietly and will only surface something when it genuinely needs you.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {inbox.needsYou.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-300">
                <AlertCircle className="h-3.5 w-3.5" /> Needs you
              </h2>
              <ul className="space-y-2">
                {inbox.needsYou.map((i) => <li key={i.id}><Row item={i} urgent /></li>)}
              </ul>
            </section>
          )}

          {inbox.today.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <Sun className="h-3.5 w-3.5" /> For today
              </h2>
              <ul className="space-y-2">
                {inbox.today.map((i) => <li key={i.id}><Row item={i} /></li>)}
              </ul>
            </section>
          )}
        </div>
      )}

      {/* Quieted — deliberately collapsed so the surface stays calm */}
      {inbox.quieted > 0 && (
        <button
          onClick={() => setShowQuiet((v) => !v)}
          className="mt-6 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 text-xs text-muted transition hover:text-fg"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition', showQuiet && 'rotate-180')} />
          {inbox.quieted} quieter {inbox.quieted === 1 ? 'item is' : 'items are'} handled in the background
        </button>
      )}
      {showQuiet && (
        <p className="mt-2 px-2 text-center text-xs text-muted">
          Bubaly is tracking these across your hubs — you don’t need to act on them now. Open the
          {' '}<Link href="/dashboard/family-operating-index" className="text-brand hover:underline">Operating Index</Link>{' '}
          or <Link href="/dashboard/agents" className="text-brand hover:underline">Family Assistant</Link> to see the full picture.
        </p>
      )}
    </div>
  );
}
