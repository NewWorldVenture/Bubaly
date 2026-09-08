import { FAQAccordion } from '@/components/marketing/faq-accordion';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { localizeAeoQuestions, readAeoQuestionsForPathCached } from '@/lib/marketing/aeo';

export async function MarketingAeoSection({
  path,
  name,
  description,
}: {
  path: string;
  name: string;
  description: string;
}) {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const result = await readAeoQuestionsForPathCached(path);
  // The heading and description come from the message catalogue, so without
  // this the section rendered translated chrome around English answers.
  const localized = await localizeAeoQuestions(result.questions, locale.code);
  const items = localized.map((item) => ({ q: item.question, a: item.answer }));

  return (
    <>
      <MarketingPageStructuredData path={path} name={name} description={description} questions={items} />
      {items.length > 0 ? (
        <Section className="pt-0">
          <SectionHeading
            eyebrow={t('marketingAeoSection.knowledgeCenter')}
            title={t('marketingAeoSection.answersAbout', { name })}
            description={t('marketingAeoSection.clearAnswersMaintainedByThe')}
          />
          <div className="mx-auto mt-10 max-w-3xl">
            <FAQAccordion items={items} />
          </div>
        </Section>
      ) : null}
    </>
  );
}
