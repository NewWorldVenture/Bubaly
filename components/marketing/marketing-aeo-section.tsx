import { FAQAccordion } from '@/components/marketing/faq-accordion';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { readAeoQuestionsForPath } from '@/lib/marketing/aeo';

export async function MarketingAeoSection({
  path,
  name,
  description,
}: {
  path: string;
  name: string;
  description: string;
}) {
  const result = await readAeoQuestionsForPath(path);
  const items = result.questions.map((item) => ({ q: item.question, a: item.answer }));

  return (
    <>
      <MarketingPageStructuredData path={path} name={name} description={description} questions={items} />
      {items.length > 0 ? (
        <Section className="pt-0">
          <SectionHeading
            eyebrow="Knowledge Center"
            title={`Answers about ${name}`}
            description="Clear answers maintained by the Bubaly team and kept in sync with the public site."
          />
          <div className="mx-auto mt-10 max-w-3xl">
            <FAQAccordion items={items} />
          </div>
        </Section>
      ) : null}
    </>
  );
}
