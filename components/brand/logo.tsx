import Link from 'next/link';
import { Home, UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function LogoMark({
  className,
  variant = 'family',
}: {
  className?: string;
  variant?: 'family' | 'home';
}) {
  const Icon = variant === 'home' ? Home : UsersRound;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center text-violet-400',
        className,
      )}
    >
      <Icon className="h-full w-full" strokeWidth={2.4} />
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
    <Link href={href} className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="h-9 w-9" variant={markVariant} />
      {showText && (
        <span className="text-2xl font-bold">
          FamilyOS
        </span>
      )}
    </Link>
  );
}
