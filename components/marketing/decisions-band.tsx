// "It handles the routine. It asks about the rest." — the homepage's honest
// account of what Bubaly does alone and what always waits for a parent.
//
// The always-asks list is not typed here. It is HIGH_STAKES_AI_DOMAINS
// (lib/trust/engine.ts) partitioned by lib/marketing/trust-copy.ts and
// rendered through the trustDomains.* keys, so the page cannot promise less
// caution than the engine enforces, and cannot go on naming a domain the
// engine stopped guarding.
import Link from 'next/link';
import { Eye, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { BandHeader, Container } from '@/components/marketing/visual-mocks';
import { HIGH_STAKES_GROUP_ORDER, highStakesGroups, trustDomainKey, trustGroupKey } from '@/lib/marketing/trust-copy';
import { ROLE_DEFAULTS } from '@/lib/trust/engine';

export async function DecisionsBand() {
  const t = await getTranslations();
  const groups = highStakesGroups();
  const kidsReviewed = ROLE_DEFAULTS.child.automationTrusted === false;

  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
      <BandHeader eyebrow={t('decisionsBand.eyebrow')} title={t('decisionsBand.title')} align="center" />

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <article className="showcase-card p-5">
          <Sparkles className="h-5 w-5 text-emerald-400" aria-hidden />
          <h3 className="mt-3 text-base font-semibold">{t('decisionsBand.handlesTitle')}</h3>
          <p className="mt-2 text-sm leading-6 text-white/65">{t('decisionsBand.handlesBody')}</p>
        </article>

        <article className="showcase-card p-5">
          <ShieldCheck className="h-5 w-5 text-violet-300" aria-hidden />
          <h3 className="mt-3 text-base font-semibold">{t('decisionsBand.asksTitle')}</h3>
          <p className="mt-2 text-sm leading-6 text-white/65">{t('decisionsBand.asksBody')}</p>
          <ul className="mt-3 space-y-2">
            {HIGH_STAKES_GROUP_ORDER.filter((group) => groups[group].length > 0).map((group) => (
              <li key={group} className="text-xs leading-5 text-white/75">
                <span className="font-semibold text-white/90">{t(trustGroupKey(group))}:</span>{' '}
                {groups[group].map((domain) => t(trustDomainKey(domain))).join(', ')}
              </li>
            ))}
          </ul>
          {kidsReviewed && <p className="mt-3 text-xs leading-5 text-white/55">{t('decisionsBand.kidsLine')}</p>}
        </article>

        <article className="showcase-card p-5">
          <Eye className="h-5 w-5 text-blue-300" aria-hidden />
          <h3 className="mt-3 text-base font-semibold">{t('decisionsBand.neverTitle')}</h3>
          <p className="mt-2 text-sm leading-6 text-white/65">{t('decisionsBand.neverBody')}</p>
        </article>
      </div>

      <div className="mt-8 flex flex-col items-center gap-3 xs:flex-row xs:justify-center">
        <Link href="/security#ai-trust" className="focus-visible:focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.025] px-5 text-sm font-semibold text-white transition hover:bg-white/[0.07]">
          <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
          {t('decisionsBand.readTrustCenter')}
        </Link>
        <Link href="/ai" className="focus-visible:focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold text-violet-300 transition hover:bg-white/[0.045]">
          <Wand2 className="h-4 w-4" aria-hidden />
          {t('decisionsBand.seeItAct')}
        </Link>
      </div>
    </Container>
  );
}
