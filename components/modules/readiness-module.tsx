// Life Readiness — answers "are we ready?" for tomorrow, this week, this month.
// Presentational: the server page rolls live signals through the pure engine
// (lib/readiness/assess.ts) and passes the cards here. No client state needed.
import Link from 'next/link';
import { ShieldCheck, AlertTriangle, CircleCheck, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { ReadinessCard, ReadinessStatus } from '@/lib/readiness/assess';

const STATUS: Record<ReadinessStatus, { label: string; ring: string; text: string; Icon: typeof CircleCheck }> = {
  ready: { label: 'Ready', ring: 'stroke-emerald-400', text: 'text-emerald-300', Icon: CircleCheck },
  at_risk: { label: 'At risk', ring: 'stroke-amber-400', text: 'text-amber-300', Icon: AlertTriangle },
  not_ready: { label: 'Not ready', ring: 'stroke-rose-400', text: 'text-rose-300', Icon: AlertTriangle },
};

function Dial({ score, status }: { score: number; status: ReadinessStatus }) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return (
    <div className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
        <circle cx="32" cy="32" r={r} className="fill-none stroke-muted/15" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} className={cn('fill-none', STATUS[status].ring)} strokeWidth="6"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" />
      </svg>
      <span className={cn('absolute inset-0 flex items-center justify-center text-sm font-bold', STATUS[status].text)}>{score}</span>
    </div>
  );
}

export function ReadinessModule({ cards, overall }: { cards: ReadinessCard[]; overall: { score: number; status: ReadinessStatus } }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Life Readiness" description="Not another list of data — a straight answer to “are we ready?”, and what to close if not." />
      <ReadinessHorizons cards={cards} overall={overall} />
    </div>
  );
}

/** The forward-looking horizon section (no page header) — embeddable on the
 *  existing Family Readiness page beneath its current-state gauge. */
export function ReadinessHorizons({ cards, overall }: { cards: ReadinessCard[]; overall: { score: number; status: ReadinessStatus } }) {
  const O = STATUS[overall.status];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
        <Dial score={overall.score} status={overall.status} />
        <div>
          <div className={cn('flex items-center gap-1.5 text-sm font-semibold', O.text)}>
            <O.Icon className="size-4" /> {O.label}
          </div>
          <p className="text-sm text-muted">
            {overall.status === 'ready' ? 'Everything ahead looks handled.' : 'Weakest horizon sets the tone — close the gaps below.'}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => {
          const S = STATUS[card.status];
          return (
            <div key={card.horizon} className="flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold">{card.title}</h3>
                <span className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]', S.text,
                  card.status === 'ready' ? 'border-emerald-500/30 bg-emerald-500/10' : card.status === 'at_risk' ? 'border-amber-500/30 bg-amber-500/10' : 'border-rose-500/30 bg-rose-500/10')}>
                  <S.Icon className="size-3" /> {S.label}
                </span>
              </div>
              <p className="mb-3 text-sm text-muted">{card.headline}</p>
              {card.gaps.length > 0 ? (
                <ul className="mt-auto space-y-1.5">
                  {card.gaps.map((g, i) => (
                    <li key={i}>
                      <Link href={g.href} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/5">
                        <span className="flex items-center gap-2">
                          <span className={cn('size-1.5 rounded-full', g.severity === 'blocker' ? 'bg-rose-400' : 'bg-amber-400')} />
                          {g.label}
                        </span>
                        <ArrowRight className="size-3.5 shrink-0 text-muted" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-auto flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
                  <ShieldCheck className="size-4" /> Nothing to close.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
