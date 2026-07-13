import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles, ArrowRight } from 'lucide-react';

export const metadata: Metadata = { title: 'Welcome to Bubaly' };

// Screen 1 of the onboarding mockups: a dedicated welcome / get-started card that
// greets people before the sign-up chooser. "Get started" → create an account;
// "I already have an account" → sign in. Rendered inside the (auth) layout.
export default function WelcomePage() {
  return (
    <div className="glass-card p-7 text-center animate-fade-in sm:p-9">
      <span className="ai-orb mx-auto flex h-16 w-16 items-center justify-center">
        <Sparkles className="h-7 w-7 text-brand-text" />
      </span>

      <h1 className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl">
        Welcome to Bubaly
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted">
        The AI operating system for family life. One calm home for your calendar,
        lists, meals, money and memories.
      </p>
      <p className="mt-4 text-sm font-semibold text-brand-text">
        Less Managing Life. More Living It.
      </p>

      <div className="mt-8 space-y-3">
        <Link
          href="/signup"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-4 py-3.5 text-sm font-semibold text-brand-fg shadow-glow transition hover:brightness-110"
        >
          Get started <ArrowRight className="h-4 w-4" />
        </Link>
        <Link
          href="/login"
          className="flex w-full items-center justify-center rounded-xl border border-border bg-transparent px-4 py-3.5 text-sm font-semibold text-fg transition hover:bg-elevated"
        >
          I already have an account
        </Link>
      </div>

      <p className="mt-6 text-xs text-muted">Free to start — no credit card.</p>
    </div>
  );
}
