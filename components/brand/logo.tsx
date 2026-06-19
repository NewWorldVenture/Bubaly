import Link from 'next/link';
import { Home } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function LogoMark({
  className,
  variant = 'family',
}: {
  className?: string;
  variant?: 'family' | 'home';
}) {
  if (variant === 'family') {
    return (
      <span
        className={cn('inline-flex items-center justify-center text-violet-500', className)}
        aria-hidden="true"
      >
        <svg viewBox="0 0 42 34" className="h-full w-full" fill="none">
          <circle cx="21" cy="7" r="6" fill="currentColor" />
          <circle cx="9" cy="11" r="4.5" fill="currentColor" opacity="0.92" />
          <circle cx="33" cy="11" r="4.5" fill="currentColor" opacity="0.92" />
          <path d="M12.5 30v-9.5c0-6.1 3.6-9.5 8.5-9.5s8.5 3.4 8.5 9.5V30h-17Z" fill="currentColor" />
          <path d="M1 30v-7.2c0-5.2 3.1-8.3 7.3-8.3 2 0 3.7.7 5 2-1.5 2.1-2.3 4.8-2.3 8V30H1Z" fill="currentColor" opacity="0.88" />
          <path d="M31 30v-5.5c0-3.2-.8-5.9-2.3-8 1.3-1.3 3-2 5-2 4.2 0 7.3 3.1 7.3 8.3V30H31Z" fill="currentColor" opacity="0.88" />
        </svg>
      </span>
    );
  }

  const Icon = Home;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center text-violet-400',
        className,
      )}
    >
      <Icon className="h-full w-full" strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}

export function Logo({
  href = '/',
  className,
  showText = true,
  markVariant = 'family',
}: {
  href?: string;
  className?: string;
  showText?: boolean;
  markVariant?: 'family' | 'home';
}) {
  return (
    <Link href={href} className={cn('inline-flex items-center gap-1.5', className)}>
      <LogoMark className="h-8 w-9" variant={markVariant} />
      {showText && (
        <span className="text-[25px] font-bold tracking-[-0.03em]">
          FamilyOS
        </span>
      )}
    </Link>
  );
}
