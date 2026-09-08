// X7 on the graph page — how complete the household's model is, and exactly
// what would improve it.
//
// NOT A GATE. Nothing on this card blocks anything; every missing slot is an
// optional prompt with a link to the one page that fills it. A completeness
// score with no route to raising it is a scold, so each row is a link and the
// card says plainly that the number is optional.
import { Brain } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import type { GraphCompleteness } from '@/lib/twin/completeness';

/** How many prompts to show before the list becomes a chore rather than help. */
const MAX_PROMPTS = 5;

export async function GraphCompletenessCard({
  completeness,
  retryHref,
}: {
  completeness: GraphCompleteness | null;
  retryHref: string;
}) {
  const t = await getTranslations();

  if (completeness === null) {
    return (
      <div className="mx-auto mb-4 max-w-5xl px-4">
        <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
          <p className="text-danger">{t('graphCompleteness.couldNotScoreWhatBubalyKnows')}</p>
          <a href={retryHref} className="mt-2 inline-block font-medium text-danger underline">
            {t('graphCompleteness.tryAgain')}
          </a>
        </div>
      </div>
    );
  }

  const prompts = completeness.missing.slice(0, MAX_PROMPTS);

  return (
    <div className="mx-auto mb-4 max-w-5xl px-4">
      <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-surface/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
            <Brain className="h-4 w-4" />
          </span>
          <p className="text-sm font-semibold">
            {t('graphCompleteness.bubalyKnowsNPercentOfYourHousehold', { pct: completeness.score })}
          </p>
          <span className="text-xs text-muted">
            {t('graphCompleteness.nOfNFactsFilledIn', { filled: completeness.filled, expected: completeness.expected })}
          </span>
        </div>

        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full rounded-full bg-brand" style={{ width: `${completeness.score}%` }} />
        </div>

        {prompts.length > 0 ? (
          <>
            <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t('graphCompleteness.optionalWhatWouldHelpMost')}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {prompts.map((slot) => (
                <li key={slot.key}>
                  <a
                    href={slot.href}
                    className="inline-flex items-center rounded-full border border-border bg-surface/60 px-2.5 py-1 text-xs text-muted transition hover:bg-elevated hover:text-fg"
                  >
                    {slot.memberName
                      ? t('graphCompleteness.slotForMember', { slot: t(slot.labelKey), member: slot.memberName })
                      : t(slot.labelKey)}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted">{t('graphCompleteness.bubalyHasEverythingItExpects')}</p>
        )}
      </div>
    </div>
  );
}
