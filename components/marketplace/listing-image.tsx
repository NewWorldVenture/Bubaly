'use client';

// Listing/store photo with a graceful fallback. photo_url is free text set by a
// family member, so it may be dead, blocked, or mixed-content — on error we swap
// to the caller's placeholder rather than showing a broken-image glyph.
// referrerPolicy keeps the app URL out of the Referer sent to arbitrary hosts.

import { useEffect, useState } from 'react';

export function ListingImage({
  src, alt, className, fallback,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  // Reset when the source changes (e.g. list re-renders with a new listing).
  useEffect(() => { setFailed(false); }, [src]);

  const usable = typeof src === 'string' && /^https:\/\//i.test(src.trim());
  if (!usable || failed) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src!.trim()}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
