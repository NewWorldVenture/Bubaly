'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/** Floating AI assistant button — visible on every screen except the assistant page itself. */
export function AiFab() {
  const pathname = usePathname();
  const hidden = pathname === '/dashboard/assistant' || pathname.startsWith('/dashboard/assistant/');

  if (hidden) return null;

  return (
    <Link
      href="/dashboard/assistant"
      aria-label="Open AI Assistant"
      className={cn(
        'fixed bottom-24 right-4 z-50 flex h-14 w-14 items-center justify-center',
        'rounded-full bg-brand shadow-lg shadow-brand/30 text-white',
        'transition hover:scale-105 hover:shadow-brand/40 active:scale-95',
        'lg:bottom-6 lg:right-6',
      )}
    >
      <Sparkles className="h-6 w-6" />
    </Link>
  );
}
