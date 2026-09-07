import Image from 'next/image';
import { useTranslations } from '@/components/i18n/locale-provider';
import Link from 'next/link';
import { cn } from '@/lib/utils/cn';

export function LogoMark({
  className,
  variant: _variant = 'family',
}: {
  className?: string;
  variant?: 'family' | 'home';
}) {
  return (
    <span
      className={cn('relative inline-block shrink-0', className)}
      aria-hidden="true"
    >
      <Image
        src="/brand/bubaly-mark.png"
        alt=""
        fill
        sizes="96px"
        className="object-contain"
      />
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
  const t = useTranslations();
  return (
    <Link
      href={href}
      aria-label={t('logo.bubalyHome')}
      className={cn('inline-flex shrink-0 items-center', className)}
    >
      {showText ? (
        <Image
          src="/brand/bubaly-logo.png"
          alt={t('logo.bubaly')}
          width={1143}
          height={618}
          priority
          className="h-14 w-auto object-contain"
        />
      ) : (
        <LogoMark className="h-8 w-14" variant={markVariant} />
      )}
    </Link>
  );
}
