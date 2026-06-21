import { cn } from '@/lib/utils/cn';
import { PROVIDERS, type SocialPlatform } from '@/lib/social/capabilities';

/** Brand-tinted chip showing a platform. Server-safe (no client hooks). */
export function PlatformBadge({
  platform,
  className,
  showLabel = true,
}: {
  platform: SocialPlatform;
  className?: string;
  showLabel?: boolean;
}) {
  const def = PROVIDERS[platform];
  const initial = def.label.charAt(0).toUpperCase();
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-border bg-elevated px-2 py-0.5 text-xs font-medium', className)}
      title={def.label}
    >
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white"
        style={{ backgroundColor: def.brandColor }}
        aria-hidden
      >
        {initial}
      </span>
      {showLabel && <span>{def.label}</span>}
    </span>
  );
}

export function PlatformDot({ platform }: { platform: SocialPlatform }) {
  const def = PROVIDERS[platform];
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-bold text-white"
      style={{ backgroundColor: def.brandColor }}
      title={def.label}
      aria-label={def.label}
    >
      {def.label.charAt(0).toUpperCase()}
    </span>
  );
}
