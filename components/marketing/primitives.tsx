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
 * Its turn has come: every label arrives as a prop, so this renders in the
 * visitor's language without importing `lib/i18n/server` — which it must not do
 * (see the note at the top of this file). Callers pass translated copy; the
 * defaults are English so a caller that has not been updated still renders
 * words rather than blanks.
 */
export type TrustStripCopy = {
  familiesNote?: string;
  privateTitle?: string; privateBody?: string;
  responsiveTitle?: string; responsiveBody?: string;
  updatesTitle?: string; updatesBody?: string;
  communityTitle?: string;
};

export function TrustStrip({
  familiesNote = 'Built for modern family life',
  privateTitle = 'Private by Design', privateBody = 'Family-scoped access controls',
  responsiveTitle = 'Responsive by Design', responsiveBody = 'Web, iOS, and Android layouts',
  updatesTitle = 'Shared Updates', updatesBody = 'Family changes stay in sync',
  communityTitle = 'Family Community',
}: TrustStripCopy) {
  const items = [
    [Shield, privateTitle, privateBody],
    [Home, responsiveTitle, responsiveBody],
    [Sparkles, updatesTitle, updatesBody],
    [Heart, communityTitle, familiesNote],
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
