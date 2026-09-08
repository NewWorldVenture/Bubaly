// "Bubaly Handled" — the homepage's proof band (id="handled", the hero's
// "See a handled week" target).
//
// Two visibly different kinds of evidence, never mixed in one sentence:
//   REAL — cross-family aggregates from public_stats() / public_handled_stats(),
//          each line rendered only when its formatter says the count is large
//          enough to print (lib/marketing/format.ts). Zero renders nothing.
//   ILLUSTRATIVE — a fictional family's Daily Brief and ledger, badged
//          "Illustrative sample" in every card header. The brief's numbers
//          are computed by the app's own composer (lib/marketing/handled-sample.ts).
// There is deliberately no third "live" tier: demo mode was removed in #414, so
// the band links to the Trust Center — a page that exists — instead of offering
// a shared demo account the product no longer has.
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock, Heart, ListChecks, ShieldCheck, Sparkles } from 'lucide-react';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { Container, Pill, SampleBadge } from '@/components/marketing/visual-mocks';
import { HANDLED_SAMPLE, sampleBriefNumbers, type HandledSampleRow } from '@/lib/marketing/handled-sample';
import { familiesNote, formatHandled, handledNote, meetsHandledFloor } from '@/lib/marketing/format';
import { getPublicStats } from '@/lib/marketing/stats';

function StateIcon({ row, partlyDone }: { row: HandledSampleRow; partlyDone: string }) {
  if (row.state === 'partial') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label={partlyDone} />;
  if (row.state === 'awaiting_ok') return <Clock className="mt-0.5 h-4 w-4 shrink-0 text-white/60" aria-hidden />;
  return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />;
}

export async function HandledLedger() {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const stats = await getPublicStats();
  const numbers = sampleBriefNumbers();
  const weekday = new Intl.DateTimeFormat(locale.code, { weekday: 'short', timeZone: 'UTC' });

  // Every handled aggregate is gated by the same floor (HANDLED_PUBLIC_MIN),
  // and the family count by zero. An empty list renders no list at all — the
  // band never prints "0" or a placeholder. The sentences come from the same
  // formatters the pricing page uses, so the two surfaces cannot disagree.
  const aggregates: { key: string; icon: typeof Sparkles; text: string }[] = [];
  const handledLine = handledNote(t, stats.handledCompleted);
  if (handledLine) {
    aggregates.push({ key: 'handled', icon: Sparkles, text: handledLine });
  }
  if (meetsHandledFloor(stats.handled30d)) {
    aggregates.push({ key: 'handled30d', icon: Clock, text: t('handledProof.aggregate30d', { count: formatHandled(stats.handled30d) }) });
  }
  if (meetsHandledFloor(stats.tasksCompleted)) {
    aggregates.push({ key: 'chores', icon: ListChecks, text: t('handledProof.choresAggregate', { count: formatHandled(stats.tasksCompleted) }) });
  }
  if (stats.families > 0) {
    aggregates.push({ key: 'families', icon: Heart, text: familiesNote(t, stats.families) });
  }

  return (
    <section id="handled" className="scroll-mt-24">
      <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12">
          {/* Left — what this is, and the real numbers when there are any */}
          <div>
            <Pill icon={CheckCircle2}>{t('handledProof.eyebrow')}</Pill>
            <h2 className="mt-5 text-balance text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{t('handledProof.title')}</h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-white/70 sm:text-lg sm:leading-8">{t('handledProof.body')}</p>

            {aggregates.length > 0 && (
              <ul className="mt-6 space-y-2.5">
                {aggregates.map(({ key, icon: Icon, text }) => (
                  <li key={key} className="flex items-center gap-3 text-sm text-white/85">
                    <Icon className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                    {text}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-7 flex flex-col gap-3 xs:flex-row xs:flex-wrap">
              <Link href="/security#ai-trust" className="focus-visible:focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-sm font-semibold text-brand-fg shadow-glow transition hover:brightness-110">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {t('handledProof.readTrustCenter')}
              </Link>
            </div>
          </div>

          {/* Right — the badged sample: a brief card, then the ledger */}
          <div className="flex flex-col gap-4">
            <article className="showcase-card p-5" aria-label={t('handledProof.sampleBriefLabel')}>
              <header className="flex items-start justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/55">{t('handledProof.sampleBriefLabel')}</span>
                <SampleBadge>{t('handledProof.sampleBadge')}</SampleBadge>
              </header>
              <p className="mt-3 text-lg font-bold leading-snug sm:text-xl">
                {t('handledProof.sampleBriefHeadline', { today: numbers.today, clashes: numbers.clashes, handled: numbers.handled })}
              </p>
            </article>

            <article className="showcase-card p-5">
              <header className="flex items-start justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-white/55">{t('handledProof.eyebrow')}</span>
                <SampleBadge>{t('handledProof.sampleBadge')}</SampleBadge>
              </header>
              <ul className="mt-4 space-y-1.5">
                {HANDLED_SAMPLE.map((row) => (
                  <li key={row.key} className="flex min-h-[44px] items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5">
                    <StateIcon row={row} partlyDone={t('completedByBubaly.partlyDone')} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/90">{t(row.titleKey)}</p>
                      <p className="mt-0.5 text-xs leading-5 text-white/60">{t(row.detailKey)}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {row.steps && (
                          <span className="text-[11px] text-white/50">{t('handledProof.stepsComplete', { done: row.steps.done, total: row.steps.total })}</span>
                        )}
                        {row.state === 'awaiting_ok' && (
                          <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-white/85">
                            {t('handledProof.waitingForYourOk')}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-white/50">{weekday.format(new Date(row.at))}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs leading-5 text-white/55">{t('handledProof.sampleNote')}</p>
            </article>
          </div>
        </div>
      </Container>
    </section>
  );
}
