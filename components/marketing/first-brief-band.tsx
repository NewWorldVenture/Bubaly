// "Your first two minutes" — the three steps a new family actually takes:
// bring a calendar (the onboarding 'value' step, lib/onboarding/flow.ts), get
// the first brief (lib/onboarding/first-brief.ts), choose what Bubaly may
// handle per area (lib/ai/family-settings.ts). The dial defaults to Execute
// and the trust engine holds the line on high-stakes domains, so the copy
// says "turn any area down" — never that the default is the cautious one.
import { CalendarDays, SlidersHorizontal, Sun, type LucideIcon } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { BandHeader, Container, PrimaryLink } from '@/components/marketing/visual-mocks';

const STEPS: { icon: LucideIcon; titleKey: string; bodyKey: string }[] = [
  { icon: CalendarDays, titleKey: 'firstBrief.step1Title', bodyKey: 'firstBrief.step1Body' },
  { icon: Sun, titleKey: 'firstBrief.step2Title', bodyKey: 'firstBrief.step2Body' },
  { icon: SlidersHorizontal, titleKey: 'firstBrief.step3Title', bodyKey: 'firstBrief.step3Body' },
];

export async function FirstBriefBand() {
  const t = await getTranslations();
  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-14 sm:px-8 sm:pt-16 lg:px-10">
      <section className="showcase-panel p-6 sm:p-8 lg:p-10">
        <BandHeader eyebrow={t('firstBrief.eyebrow')} title={t('firstBrief.title')} />
        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map(({ icon: Icon, titleKey, bodyKey }, index) => (
            <li key={titleKey} className="showcase-card flex flex-col p-5">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-500/15 text-sm font-bold text-white/90 ring-1 ring-violet-400/30">{index + 1}</span>
                <Icon className="h-5 w-5 text-violet-300" aria-hidden />
              </div>
              <h3 className="mt-4 text-base font-semibold">{t(titleKey)}</h3>
              <p className="mt-2 text-sm leading-6 text-white/65">{t(bodyKey)}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8 flex justify-center sm:justify-start">
          <PrimaryLink href="/signup">{t('firstBrief.cta')}</PrimaryLink>
        </div>
      </section>
    </Container>
  );
}
