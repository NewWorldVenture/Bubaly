import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpenCheck, CreditCard, LifeBuoy, Mail, ShieldCheck, type LucideIcon } from 'lucide-react';
import { Container, PageWrap, Pill } from '@/components/marketing/visual-mocks';
import { FaqExplorer, type FaqIcon, type FaqTopic } from '@/components/marketing/faq-explorer';
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

// Locale is resolved per request from the cookie and Accept-Language, so this
// page CANNOT be cached per URL — and declaring `revalidate` while reading
// cookies is not a no-op, it is a runtime failure. Next prerenders the route,
// then sees the cookie read on a later request and throws
// "Page changed from static to dynamic at runtime … reason: cookies", so the
// background revalidation never succeeds and the page silently stops updating.
export const dynamic = 'force-dynamic';

/** A question as the module declares it: catalogue keys, and the pages that say more. */
type FaqItemKeys = { id: string; q: string; a: string; links?: { href: string; label: string }[] };

/** A section of the page — a card in the topic grid, an entry in the side nav. */
type FaqSection = { id: string; label: string; blurb: string; icon: FaqIcon; items: FaqItemKeys[] };

// Every answer here is held to what the product does today: the trial and
// prices to lib/constants/family-prices.json and the entitlement code, the
// assistant to lib/trust/engine.ts and Settings → Bubaly AI, privacy to the
// Trust Center's own copy (several answers ARE the Trust Center's keys, so the
// two pages cannot drift apart). tests/marketing-faq-nav-and-tabs.test.ts pins
// the claims that have been wrong before — a "free Starter plan" new families
// never get — and tests/marketing-claims-contract.test.ts reads this file too.
//
// Module-level data holds catalogue KEYS only; the page resolves them below.
const FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'getting-started',
    label: 'faq.topicGettingStarted',
    blurb: 'faq.topicGettingStartedBlurb',
    icon: 'start',
    items: [
      { id: 'what-is-bubaly', q: 'faq.whatIsBubalyQ', a: 'faq.whatIsBubalyA', links: [{ href: '/how-it-works', label: 'faq.linkHowItWorks' }] },
      { id: 'who-is-it-for', q: 'faq.whoIsItForQ', a: 'faq.whoIsItForA', links: [{ href: '/features', label: 'faq.linkFeatures' }] },
      { id: 'setup-time', q: 'faq.setupTimeQ', a: 'faq.setupTimeA' },
      { id: 'everyone-needs-an-account', q: 'faq.everyoneAccountQ', a: 'faq.everyoneAccountA' },
    ],
  },
  {
    id: 'ai-assistant',
    label: 'faq.aiAssistant',
    blurb: 'faq.topicAiBlurb',
    icon: 'ai',
    items: [
      { id: 'ai-takes-action', q: 'faq.doesTheAiAssistantActually', a: 'faq.itTakesRealActionWhen', links: [{ href: '/ai', label: 'faq.linkAi' }] },
      { id: 'ai-asks-first', q: 'faq.aiAsksFirstQ', a: 'faq.aiAsksFirstA', links: [{ href: '/security#ai-trust', label: 'faq.linkAiTrust' }] },
      { id: 'ai-shows-its-work', q: 'faq.aiLedgerQ', a: 'faq.aiLedgerA' },
      { id: 'ai-training', q: 'faq.aiTrainingQ', a: 'faq.aiTrainingA' },
      { id: 'ai-switch-off', q: 'faq.aiOffQ', a: 'faq.aiOffA' },
    ],
  },
  {
    id: 'privacy-security',
    label: 'faq.privacySecurity',
    blurb: 'faq.topicPrivacyBlurb',
    icon: 'privacy',
    items: [
      { id: 'is-my-data-private', q: 'faq.isMyFamilySData', a: 'faq.yesEveryDatabaseTableEnforces', links: [{ href: '/security', label: 'faq.linkTrustCenter' }] },
      { id: 'encryption', q: 'security.faqEncryptionQ', a: 'security.faqEncryptionAnswer' },
      { id: 'do-you-sell-data', q: 'security.faqSellDataQ', a: 'security.faqSellDataAnswer' },
      { id: 'where-is-data-stored', q: 'security.faqRegionQ', a: 'security.faqRegionAnswer' },
      { id: 'export-or-delete', q: 'faq.exportDeleteQ', a: 'faq.exportDeleteA', links: [{ href: '/privacy', label: 'faq.linkPrivacy' }] },
      { id: 'report-a-concern', q: 'security.faqReportQ', a: 'security.faqReportAnswer' },
    ],
  },
  {
    id: 'roles-access',
    label: 'faq.rolesAccess',
    blurb: 'faq.topicRolesBlurb',
    icon: 'family',
    items: [
      { id: 'roles', q: 'faq.howDoRolesWork', a: 'faq.thereAreSixRolesParent' },
      { id: 'babysitters-and-grandparents', q: 'faq.canIInviteABabysitter', a: 'faq.absolutelyInviteThemAsA' },
      { id: 'how-many-members', q: 'faq.memberLimitQ', a: 'faq.memberLimitA' },
      { id: 'more-than-one-family', q: 'faq.moreFamiliesQ', a: 'faq.moreFamiliesA' },
    ],
  },
  {
    id: 'kids-safety',
    label: 'faq.kidsSafety',
    blurb: 'faq.topicKidsBlurb',
    icon: 'kids',
    items: [
      { id: 'kids-use-safely', q: 'faq.canChildrenUseItSafely', a: 'faq.yesChildrenGetASimple' },
      { id: 'kids-accounts', q: 'faq.kidsAccountsQ', a: 'faq.kidsAccountsA' },
      { id: 'childrens-data', q: 'security.faqChildrenQ', a: 'security.faqChildrenAnswer' },
      { id: 'teens', q: 'faq.teensQ', a: 'faq.teensA' },
      { id: 'chores-and-rewards', q: 'faq.choresQ', a: 'faq.choresA' },
    ],
  },
  {
    id: 'calendars-imports',
    label: 'faq.topicCalendars',
    blurb: 'faq.topicCalendarsBlurb',
    icon: 'calendar',
    items: [
      { id: 'calendar-sync', q: 'faq.calendarSyncQ', a: 'faq.calendarSyncA' },
      { id: 'school-and-team-calendars', q: 'faq.feedsQ', a: 'faq.feedsA' },
      { id: 'switching', q: 'faq.switchingQ', a: 'faq.switchingA', links: [{ href: '/features#switching', label: 'faq.linkSwitching' }] },
    ],
  },
  {
    id: 'plans-pricing',
    label: 'faq.plansPricing',
    blurb: 'faq.topicPricingBlurb',
    icon: 'pricing',
    items: [
      { id: 'cost', q: 'faq.whatDoesItCost', a: 'faq.whatDoesItCostA', links: [{ href: '/pricing', label: 'faq.linkPricing' }] },
      { id: 'trial-ends', q: 'faq.trialEndsQ', a: 'faq.trialEndsA' },
      { id: 'basic-or-plus', q: 'faq.basicVsPlusQ', a: 'faq.basicVsPlusA', links: [{ href: '/pricing', label: 'faq.linkComparePlans' }] },
      { id: 'per-person', q: 'faq.perPersonQ', a: 'faq.perPersonA' },
      { id: 'cancel', q: 'faq.cancelQ', a: 'faq.cancelA' },
    ],
  },
  {
    id: 'mobile-notifications',
    label: 'faq.mobileAlerts',
    blurb: 'faq.topicMobileBlurb',
    icon: 'devices',
    items: [
      { id: 'mobile-app', q: 'faq.isThereAMobileApp', a: 'faq.mobileAppA', links: [{ href: '/mobile', label: 'faq.linkMobile' }] },
      { id: 'notifications', q: 'faq.howDoNotificationsWork', a: 'faq.notificationsA' },
      { id: 'quiet-hours', q: 'faq.quietHoursQ', a: 'faq.quietHoursA' },
      // Kitchen Mode: the same software on a tablet the family already owns.
      { id: 'kitchen-mode', q: 'faq.kitchenModeQ', a: 'faq.kitchenModeA', links: [{ href: '/features#kitchen-mode', label: 'faq.linkKitchenMode' }] },
      { id: 'languages', q: 'faq.languagesQ', a: 'faq.languagesA' },
    ],
  },
];

/** The chips under the search box: the questions most visitors arrive with. */
const POPULAR = ['what-is-bubaly', 'cost', 'ai-asks-first', 'is-my-data-private', 'calendar-sync'];

const HELP_CARDS: { href: string; icon: LucideIcon; title: string; body: string }[] = [
  { href: '/contact', icon: Mail, title: 'faq.helpContactTitle', body: 'faq.helpContactBody' },
  { href: '/security', icon: ShieldCheck, title: 'faq.helpTrustTitle', body: 'faq.helpTrustBody' },
  { href: '/how-it-works', icon: BookOpenCheck, title: 'faq.helpTourTitle', body: 'faq.helpTourBody' },
  { href: '/pricing', icon: CreditCard, title: 'faq.helpPricingTitle', body: 'faq.helpPricingBody' },
];

/** An anchor for a Knowledge Center answer: its row id where it has one. */
function knowledgeId(id: string, index: number): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? `kc-${safe}` : `kc-${index + 1}`;
}

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
  const knowledge = localizedKnowledge.map((q, index) => ({ id: knowledgeId(q.id, index), q: q.question, a: q.answer }));

  // FAQ_SECTIONS holds catalogue KEYS (it is module-level, where `t` does not
  // exist). Resolve them HERE rather than inside the explorer: it also renders
  // `knowledge`, whose questions and answers are real text authored in the
  // admin console. A t() call down there would translate the static entries
  // and pass the database rows through a lookup that cannot match them.
  const core: FaqTopic[] = FAQ_SECTIONS.map((section) => ({
    ...section,
    label: t(section.label),
    blurb: t(section.blurb),
    items: section.items.map((item) => ({
      id: item.id,
      q: t(item.q),
      a: t(item.a),
      links: item.links?.map((link) => ({ href: link.href, label: t(link.label) })),
    })),
  }));

  // The live Knowledge Center becomes its own section when answers are published.
  const sections: FaqTopic[] = knowledge.length > 0
    ? [...core, { id: 'knowledge-center', label: t('faq.knowledgeCenter'), blurb: t('faq.topicKnowledgeBlurb'), icon: 'knowledge', items: knowledge }]
    : core;

  // Everything (core + Knowledge Center) participates in the FAQPage schema.
  const schemaItems = sections.flatMap((section) => section.items).slice(0, 100);

  return (
    <PageWrap>
      <FaqStructuredData items={schemaItems} />
      <MarketingPageStructuredData path="/faq" name={t('faq.faqFamilyKnowledgeCenter')} description={t('faq.answersToCommonQuestionsAbout')} />

      <Container className="pb-8 pt-16 lg:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <Pill icon={LifeBuoy}>{t('faq.heroEyebrow')}</Pill>
          <h1 className="mt-5 text-balance text-4xl font-black leading-[1.08] sm:text-5xl lg:text-6xl">{t('faq.questionsAnswered')}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg leading-8 text-white/65">{t('faq.heroBody')}</p>
        </div>

        {!aeo.available && (
          <p className="mx-auto mt-8 max-w-2xl rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-800 dark:text-amber-200" role="status">
            {t('faq.theLiveKnowledgeCenterIs')}
          </p>
        )}

        <FaqExplorer topics={sections} popular={POPULAR} />
      </Container>

      {/* Still stuck — the people and pages behind the answers */}
      <Container className="py-20">
        <section aria-labelledby="faq-help-heading" className="rounded-3xl border border-white/8 bg-white/[0.025] p-6 sm:p-10">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-14">
            <div>
              <h2 id="faq-help-heading" className="text-balance text-3xl font-black tracking-tight sm:text-4xl">{t('faq.helpTitle')}</h2>
              <p className="mt-4 text-lg leading-8 text-white/65">{t('faq.helpBody')}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/contact" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-6 py-3 text-sm font-bold text-brand-fg shadow-glow transition hover:-translate-y-0.5">
                  {t('faq.helpContactCta')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <a href="mailto:support@bubaly.com" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3 text-sm font-bold transition hover:bg-white/[0.06]">
                  <Mail className="h-4 w-4 text-brand-text" aria-hidden />
                  {t('faq.helpEmailCta')}
                </a>
              </div>
            </div>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {HELP_CARDS.map(({ href, icon: Icon, title, body }) => (
                <li key={href}>
                  <Link href={href} className="group flex h-full flex-col rounded-2xl border border-white/8 bg-white/[0.03] p-5 transition hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-white/[0.05]">
                    <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.04]">
                      <Icon className="h-5 w-5 text-brand-text" aria-hidden />
                    </span>
                    <span className="mt-4 flex items-center gap-2 font-bold">
                      {t(title)}
                      <ArrowRight className="h-4 w-4 text-white/40 transition group-hover:translate-x-0.5 group-hover:text-brand-text" aria-hidden />
                    </span>
                    <span className="mt-1 text-sm leading-6 text-white/60">{t(body)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </Container>

      <CTASection />
    </PageWrap>
  );
}
