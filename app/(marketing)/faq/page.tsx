import type { Metadata } from 'next';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { type FAQ } from '@/components/marketing/faq-accordion';
import { FaqTabs, type FaqSection } from '@/components/marketing/faq-tabs';
import { CTASection } from '@/components/marketing/cta';
import { FaqStructuredData, MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { localizeAeoQuestions, readPublishedAeoQuestionsCached } from '@/lib/marketing/aeo';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/faq', {
  title: t('faq.faqFamilyKnowledgeCenter'),
  description: t('faq.answersToTheQuestionsFamilies'),
  });
}

export const revalidate = 3600;

// Core FAQs grouped into sections — each section becomes a tab on the page.
const FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'privacy-security',
    label: 'faq.privacySecurity',
    items: [
      { q: 'faq.isMyFamilySData', a: 'faq.yesEveryDatabaseTableEnforces' },
    ],
  },
  {
    id: 'roles-access',
    label: 'faq.rolesAccess',
    items: [
      { q: 'faq.howDoRolesWork', a: 'faq.thereAreSixRolesParent' },
      { q: 'faq.canIInviteABabysitter', a: 'faq.absolutelyInviteThemAsA' },
    ],
  },
  {
    id: 'ai-assistant',
    label: 'faq.aiAssistant',
    items: [
      { q: 'faq.doesTheAiAssistantActually', a: 'faq.itTakesRealActionWhen' },
    ],
  },
  {
    id: 'kids-safety',
    label: 'faq.kidsSafety',
    items: [
      { q: 'faq.canChildrenUseItSafely', a: 'faq.yesChildrenGetASimple' },
    ],
  },
  {
    id: 'plans-pricing',
    label: 'faq.plansPricing',
    items: [
      { q: 'faq.whatDoesItCost', a: 'faq.thereSAFreeStarter' },
    ],
  },
  {
    id: 'mobile-notifications',
    label: 'faq.mobileAlerts',
    items: [
      { q: 'faq.isThereAMobileApp', a: 'faq.bubalyIsAnInstallableProgressive' },
      { q: 'faq.howDoNotificationsWork', a: 'faq.bubalySendsTimelyPushAnd' },
      // Kitchen Mode: the same software on a tablet the family already owns.
      { q: 'faq.kitchenModeQ', a: 'faq.kitchenModeA' },
    ],
  },
];

export default async function FAQPage() {
  const t = await getTranslations();
  // The Knowledge Center is driven by the admin AEO console: published
  // marketing_aeo_questions render here + feed the FAQPage structured data, so
  // adding/editing an answer in /admin/marketing/aeo updates this page and its
  // rich results automatically — no duplication.
  const aeo = await readPublishedAeoQuestionsCached(60);
  // Through `localizeAeoQuestions`, exactly as MarketingAeoSection does on every
  // other page. Without it this page — the one whose entire subject is answers —
  // rendered a translated heading, translated tabs and translated core FAQs over
  // an English Knowledge Center, which is the half-translated state migration
  // 0277 exists to end. English locales skip the lookup; a reader in another
  // language sees the questions that have been translated and not the rest.
  const { locale } = await getLocaleContext();
  const localizedKnowledge = await localizeAeoQuestions(aeo.questions, locale.code);
  const knowledge: FAQ[] = localizedKnowledge.map((q) => ({ q: q.question, a: q.answer }));

  // FAQ_SECTIONS holds catalogue KEYS (it is module-level, where `t` does not
  // exist). Resolve them HERE rather than inside FAQAccordion: the accordion
  // also renders `knowledge`, whose questions and answers are real text authored
  // in the admin console. A t() call down there would translate the static
  // entries and pass the database rows through a lookup that cannot match them.
  const core: FaqSection[] = FAQ_SECTIONS.map((section) => ({
    ...section,
    label: t(section.label),
    items: section.items.map((item) => ({ q: t(item.q), a: t(item.a) })),
  }));

  // The live Knowledge Center becomes its own tab when answers are published.
  const sections: FaqSection[] = knowledge.length > 0
    ? [...core, { id: 'knowledge-center', label: t('faq.knowledgeCenter'), items: knowledge }]
    : core;

  // Everything (core + Knowledge Center) participates in the FAQPage schema.
  const schemaItems = sections.flatMap((section) => section.items).slice(0, 100);

  return (
    <>
      <FaqStructuredData items={schemaItems} />
      <MarketingPageStructuredData path="/faq" name={t('faq.faqFamilyKnowledgeCenter')} description={t('faq.answersToCommonQuestionsAbout')} />
      <Section className="pt-20 text-center">
        <SectionHeading eyebrow={t('marketing.nav.faq')} title={t('faq.questionsAnswered')} description={t('faq.everythingYouNeedToKnow')} />
      </Section>

      {!aeo.available && (
        <Section className="pt-0">
          <p className="mx-auto max-w-3xl rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200" role="status">
            {t('faq.theLiveKnowledgeCenterIs')}
          </p>
        </Section>
      )}

      <Section className="pt-2">
        <FaqTabs sections={sections} />
      </Section>

      <CTASection />
    </>
  );
}
