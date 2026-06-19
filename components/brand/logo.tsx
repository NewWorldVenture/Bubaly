import Link from 'next/link';
import { cn } from '@/lib/utils/cn';

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-brand to-accent font-bold text-white',
        className,
      )}
    >
      F
    </span>
  );
}

export function Logo({
  href = '/',
  className,
  showText = true,
}: {
  href?: string;
  className?: string;
  showText?: boolean;
}) {
  return (
    <Link href={href} className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="h-9 w-9 text-lg" />
      {showText && (
        <span className="text-lg font-semibold tracking-tight">
          Family<span className="gradient-text">OS</span>
        </span>
      )}
    </Link>
  );
}
