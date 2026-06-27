import Link from 'next/link';
import { Section } from '@/components/marketing/sections';

export type LegalSection = {
  id: string;
  heading: string;
  /** Paragraphs and/or bullet lists. Strings render as <p>; string[] renders as a <ul>. */
  body: (string | string[])[];
};

/**
 * World-class legal document layout — a sticky table of contents beside
 * structured, anchored sections. Theme-aware (uses brand tokens), responsive
 * (TOC collapses above the content on mobile).
 */
export function LegalPage({
  title,
  summary,
  lastUpdated,
  sections,
}: {
  title: string;
  summary: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  return (
    <>
      {/* Hero */}
      <Section className="pb-0 pt-20 text-center">
        <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand">
          Legal
        </span>
        <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">{summary}</p>
        <p className="mt-4 text-sm text-muted">Last updated: {lastUpdated}</p>
      </Section>

      <Section className="pt-12">
        <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
          {/* Sticky table of contents */}
          <aside className="hidden lg:block">
            <nav className="sticky top-24">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">On this page</p>
              <ul className="space-y-2 border-l border-border">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="-ml-px block border-l-2 border-transparent pl-4 text-sm text-muted transition hover:border-brand hover:text-fg"
                    >
                      {s.heading}
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
                  <span className="mr-2 text-muted">{i + 1}.</span>{s.heading}
                </h2>
                <div className="mt-3 space-y-4 text-[15px] leading-7 text-muted">
                  {s.body.map((block, j) =>
                    Array.isArray(block) ? (
                      <ul key={j} className="list-disc space-y-2 pl-5 marker:text-brand/60">
                        {block.map((item, k) => <li key={k}>{item}</li>)}
                      </ul>
                    ) : (
                      <p key={j}>{block}</p>
                    ),
                  )}
                </div>
              </section>
            ))}

            <div className="mt-10 rounded-2xl border border-border bg-surface/40 p-6">
              <p className="text-sm text-muted">
                Questions about this policy? Email{' '}
                <a href="mailto:support@bubaly.com" className="font-medium text-brand hover:underline">support@bubaly.com</a>{' '}
                or visit our{' '}
                <Link href="/contact" className="font-medium text-brand hover:underline">contact page</Link>.
              </p>
            </div>
          </article>
        </div>
      </Section>
    </>
  );
}
