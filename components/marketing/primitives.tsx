// Marketing layout primitives that BOTH server and client components use.
//
// They live apart from `visual-mocks.tsx` for one concrete reason: that file
// imports `lib/i18n/server`, which imports `next/headers`, which only exists in
// a server component. Importing any symbol from a module pulls the whole
// module, so a client component reaching for `Container` used to drag
// `next/headers` into the browser bundle and fail the build with
//
//   You're importing a component that needs "next/headers".
//   Import trace: lib/i18n/server.ts → visual-mocks.tsx → pricing-content.tsx
//
// Nothing here may import `lib/i18n/server`. A primitive that needs copy should
// take it as a prop from whoever renders it, or move back to `visual-mocks`.
import type React from 'react';
import { Heart, Home, Shield, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function PageWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('homepage-reference-bg min-h-dvh overflow-x-clip text-fg transition-colors duration-300', className)}>{children}</div>;
}

export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto max-w-[1360px] px-6 sm:px-10 lg:px-12', className)}>{children}</div>;
}

export function GradientText({ children }: { children: React.ReactNode }) {
  return <span className="gradient-text-violet">{children}</span>;
}

export function IconOrb({
  icon: Icon,
  tone = 'violet',
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'violet' | 'green' | 'orange' | 'blue' | 'pink';
  className?: string;
}) {
  const tones = {
    violet: 'text-violet-400 bg-violet-500/12',
    green: 'text-emerald-400 bg-emerald-500/12',
    orange: 'text-orange-400 bg-orange-500/12',
    blue: 'text-blue-400 bg-blue-500/12',
    pink: 'text-rose-400 bg-rose-500/12',
  };

  return (
    <span className={cn('icon-orb h-16 w-16', tones[tone], className)}>
      <Icon className="h-8 w-8" />
    </span>
  );
}

/**
 * `familiesNote` arrives as a prop, and the other three labels are still
 * hardcoded English — this is one of the ~900 surfaces the i18n lift has not
 * reached yet. It cannot use `getTranslations` from here (see the note above);
 * when its turn comes it takes its copy as props from its server callers.
 */
export function TrustStrip({ familiesNote = 'Built for modern family life' }: { familiesNote?: string }) {
  const items = [
    [Shield, 'Private by Design', 'Family-scoped access controls'],
    [Home, 'Responsive by Design', 'Web, iOS, and Android layouts'],
    [Sparkles, 'Shared Updates', 'Family changes stay in sync'],
    [Heart, 'Family Community', familiesNote],
  ] as const;
  return (
    <div className="grid gap-6 border-t border-white/8 py-9 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([Icon, title, body]) => (
        <div key={title} className="flex items-start gap-4">
          <IconOrb icon={Icon} className="h-12 w-12" />
          <div>
            <h3 className="font-bold">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-white/65">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Eyebrow + title + body for the homepage bands. Copy arrives as props (this
 * module cannot translate — see the header note), so the server band that
 * renders it passes `t('…')` results in.
 */
export function BandHeader({
  eyebrow,
  title,
  body,
  align = 'left',
  className,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  align?: 'left' | 'center';
  className?: string;
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <span className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{eyebrow}</span>}
      <h2 className="mt-3 text-balance text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-7 text-white/70 sm:text-lg sm:leading-8">{body}</p>}
    </div>
  );
}

/**
 * The badge every illustrative element on the public site carries. Its label
 * is `handledProof.sampleBadge` ("Illustrative sample"), passed in by the
 * caller; the pair stays readable in both themes because the text colour is
 * the canvas foreground, not the accent.
 */
export function SampleBadge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/85', className)}>
      {children}
    </span>
  );
}
