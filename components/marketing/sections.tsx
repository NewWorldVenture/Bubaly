import { cn } from '@/lib/utils/cn';

export function Section({
  className,
  children,
  id,
}: {
  className?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn('mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8', className)}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand-text">
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'center',
  as = 'h2',
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: 'center' | 'left';
  /**
   * Heading level. A section heading is an `h2` by default, which is right for
   * a section *within* a page — but four public pages (/faq, /contact, /mobile,
   * /family-display) used this component for their PAGE title and so shipped
   * with no `h1` at all, starting the document outline at `h2`.
   *
   * Pages that hand-roll a hero (/, /pricing, /features) were unaffected, which
   * is why this only ever hit the four that reused the component.
   *
   * Set `as="h1"` on the first heading of a page that has no other `h1`. The
   * styling is deliberately unchanged: this is a document-outline fix, not a
   * visual one, and the four pages should look exactly as they did.
   */
  as?: 'h1' | 'h2';
}) {
  const Heading = as;
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Heading className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{title}</Heading>
      {description && <p className="mt-4 text-lg text-muted">{description}</p>}
    </div>
  );
}

export function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="glass-card p-6 transition hover:-translate-y-0.5 hover:shadow-glow">
      <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted">{description}</p>
    </div>
  );
}
