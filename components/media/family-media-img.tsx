'use client';

// <img> for a stored family-media reference (SEC-001). The stored value is never
// put in `src` directly: it is signed with the viewer's session first, and a
// reference that cannot be signed renders the placeholder rather than the
// stored URL. See lib/storage/family-media-ref.ts for why there is no fallback.

import type { ImgHTMLAttributes, ReactNode } from 'react';
import { useFamilyMediaUrl } from '@/lib/storage/use-family-media';
import { cn } from '@/lib/utils/cn';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  /** The value as stored in the row: a family-media URL or path, or an external URL. */
  src: string | null | undefined;
  /** Rendered while signing, and in place of an image that cannot be shown. */
  fallback?: ReactNode;
};

export function FamilyMediaImg({ src, fallback, className, alt, ...rest }: Props) {
  const url = useFamilyMediaUrl(src);
  if (!url) {
    if (fallback !== undefined) return <>{fallback}</>;
    // Same box as the image would have had, so a grid does not reflow when the
    // signed URL arrives.
    return (
      <span
        className={cn('block bg-surface/40', className)}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        aria-busy={url === undefined ? true : undefined}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- a signed, expiring URL is not a candidate for the optimizer, whose output is marked public
  return <img src={url} alt={alt} className={className} {...rest} />;
}
