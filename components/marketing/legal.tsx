import Link from 'next/link';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { ChevronRight } from 'lucide-react';
import { Section } from '@/components/marketing/sections';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

/**
 * A section of a legal document, as CATALOGUE KEYS rather than copy.
 *
 * The policies are defined in module-level arrays, where `t` does not exist, so
 * the page cannot translate them itself and this component resolves every key
 * instead. Holding English here is what shipped four entirely English policy
 * pages — headings and every paragraph — to all six locales.
 */
export type LegalSection = {
  id: string;
  /** Catalogue key for the section heading. */
  heading: string;
  /** Catalogue keys. A key renders as <p>; an array of keys renders as a <ul>. */
  body: (string | string[])[];
};

/**
 * World-class legal document layout — a sticky table of contents beside
 * structured, anchored sections. Theme-aware (uses brand tokens), responsive
 * (TOC collapses above the content on mobile).
 */
export async function LegalPage({
  title,
  summary,
  lastUpdated,
  sections,
  path,
}: {
  title: string;
  summary: string;
  /** ISO date (YYYY-MM-DD), formatted in the reader's locale below. */
  lastUpdated: string;
  sections: LegalSection[];
  path: string;
}) {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  // "June 24, 2026" is a US format as well as an English one — a French reader
  // expects "24 juin 2026". Formatting from an ISO date gets both right.
  const updated = new Intl.DateTimeFormat(locale.code, { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${lastUpdated}T00:00:00Z`));
  const questions = t('legal.questionsAboutThisPolicy').split(/(\{email\}|\{contact\})/g);
  return (
    <>
      {/* Hero */}
      <Section className="pb-0 pt-20 text-center">
        <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand-text">{t('legal.legal')}</span>
        <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">{summary}</p>
        <p className="mt-4 text-sm text-muted">{t('legal.lastUpdated', { date: updated })}</p>
      </Section>

      <Section className="pt-12">
        <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
          {/* Mobile/tablet table of contents — the sticky sidebar below is
              `hidden lg:block`, so without this a phone reader gets no jump nav
              through a long legal doc. Native <details> (no JS/hydration), shown
              only < lg; the sidebar owns lg+. */}
          {sections.length > 1 && (
            <details className="group rounded-2xl border border-border bg-surface/40 lg:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold coarse:min-h-11">{t('legal.onThisPage')}<ChevronRight className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
              </summary>
              <ul className="space-y-1 border-t border-border px-3 py-2">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="flex items-center rounded-lg px-2 py-2 text-sm leading-snug text-muted transition coarse:min-h-11 hover:bg-elevated/60 hover:text-fg"
                    >
                      {t(s.heading)}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Sticky table of contents */}
          <aside className="hidden lg:block">
            <nav className="sticky top-24">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{t('legal.onThisPage')}</p>
              <ul className="space-y-2 border-l border-border">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="-ml-px block border-l-2 border-transparent pl-4 text-sm text-muted transition hover:border-brand hover:text-fg"
                    >
                      {t(s.heading)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          {/* Document body */}
          <article className="max-w-3xl">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24 border-t border-border/60 py-8 first:border-t-0 first:pt-0">
                <h2 className="text-xl font-bold tracking-tight">
                  <span className="mr-2 text-muted">{i + 1}.</span>{t(s.heading)}
                </h2>
                <div className="mt-3 space-y-4 text-[15px] leading-7 text-muted">
                  {s.body.map((block, j) =>
                    Array.isArray(block) ? (
                      <ul key={j} className="list-disc space-y-2 pl-5 marker:text-brand-text/60">
                        {block.map((item, k) => <li key={k}>{t(item)}</li>)}
                      </ul>
                    ) : (
                      <p key={j}>{t(block)}</p>
                    ),
                  )}
                </div>
              </section>
            ))}

            <div className="mt-10 rounded-2xl border border-border bg-surface/40 p-6">
              <p className="text-sm text-muted">
                {questions.map((part, i) => {
                  if (part === '{email}') {
                    return <a key={i} href="mailto:support@bubaly.com" className="font-medium text-brand-text hover:underline">support@bubaly.com</a>;
                  }
                  if (part === '{contact}') {
                    return <Link key={i} href="/contact" className="font-medium text-brand-text hover:underline">{t('legal.contactPage')}</Link>;
                  }
                  return part;
                })}
              </p>
            </div>
          </article>
        </div>
      </Section>
      <MarketingAeoSection path={path} name={title} description={summary} />
    </>
  );
}
