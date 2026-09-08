// The Trust Center's evidence ledger: one row per claim, each labelled for
// what it is — verified in the product, in place, inherited from a provider,
// or planned. Rows come from lib/marketing/trust-ledger.ts; nothing here
// decides a status, it only renders one.
//
// A 'verified' row prints the test files that pin it, because "verified" has
// to mean something a reader could check. A row without evidence prints its
// status and nothing more: no badge, no checkmark, no reassuring icon.
import { CheckCircle2, CircleDashed, Cloud, ShieldCheck } from 'lucide-react';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { cn } from '@/lib/utils/cn';
import {
  LAST_REVIEWED,
  TRUST_LEDGER,
  TRUST_LEDGER_STATUSES,
  isEvidenceUrl,
  statusHelpKey,
  statusLabelKey,
  type TrustLedgerStatus,
} from '@/lib/marketing/trust-ledger';

// The emerald/violet pairs the pricing chips already use, so both themes keep
// their contrast; the two weaker statuses stay neutral on purpose.
const STATUS_STYLE: Record<TrustLedgerStatus, { icon: typeof CheckCircle2; pill: string; iconColor: string }> = {
  verified: { icon: CheckCircle2, pill: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200', iconColor: 'text-emerald-400' },
  in_place: { icon: ShieldCheck, pill: 'border-violet-400/40 bg-violet-500/10 text-violet-200', iconColor: 'text-violet-300' },
  provider: { icon: Cloud, pill: 'border-white/15 bg-white/[0.04] text-white/75', iconColor: 'text-white/60' },
  planned: { icon: CircleDashed, pill: 'border-white/15 bg-transparent text-white/60', iconColor: 'text-white/45' },
};

function StatusPill({ status, label }: { status: TrustLedgerStatus; label: string }) {
  const { icon: Icon, pill } = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider', pill)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

export async function TrustLedger() {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const reviewed = new Date(`${LAST_REVIEWED}T00:00:00Z`);
  const reviewedLabel = new Intl.DateTimeFormat(locale.code, { dateStyle: 'long', timeZone: 'UTC' }).format(reviewed);

  return (
    <section id="ledger" className="scroll-mt-24">
      <div className="rounded-3xl border border-white/8 bg-white/[0.025] p-6 sm:p-10">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-black sm:text-4xl">{t('trustCenter.ledgerTitle')}</h2>
          <p className="mt-4 text-white/60">{t('trustCenter.ledgerBody')}</p>
        </div>

        {/* Legend: the four statuses and what each one is allowed to mean */}
        <dl className="mt-8 grid gap-3 sm:grid-cols-2">
          {TRUST_LEDGER_STATUSES.map((status) => (
            <div key={status} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <dt>
                <StatusPill status={status} label={t(statusLabelKey(status))} />
              </dt>
              <dd className="mt-2 text-sm leading-6 text-white/60">{t(statusHelpKey(status))}</dd>
            </div>
          ))}
        </dl>

        {/* The rows — a vertical list at every width, so it never scrolls sideways */}
        <ul className="mt-8 divide-y divide-white/8 rounded-2xl border border-white/8">
          {TRUST_LEDGER.map((row) => {
            const { icon: Icon, iconColor } = STATUS_STYLE[row.status];
            const evidence = row.evidence ?? [];
            return (
              <li key={row.key} id={`ledger-${row.key}`} className="scroll-mt-24 p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3">
                    <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconColor)} aria-hidden />
                    <p className="text-sm font-semibold leading-6 sm:text-base">{t(row.labelKey)}</p>
                  </div>
                  <StatusPill status={row.status} label={t(statusLabelKey(row.status))} />
                </div>
                {evidence.length > 0 && (
                  <div className="mt-3 pl-8">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{t('trustCenter.evidence')}</p>
                    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {evidence.map((item) => (
                        <li key={item} className="max-w-full">
                          {isEvidenceUrl(item) ? (
                            <a href={item} rel="noopener noreferrer" className="break-all font-mono text-xs text-violet-300 underline-offset-2 hover:underline">{item}</a>
                          ) : (
                            <code className="break-all font-mono text-xs text-white/65">{item}</code>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-xs text-white/45">
          {t('trustCenter.lastReviewed')}:{' '}
          <time dateTime={LAST_REVIEWED}>{reviewedLabel}</time>
        </p>
      </div>
    </section>
  );
}
