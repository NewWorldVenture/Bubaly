import { initials } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { readableTextOn } from '@/lib/utils/readable-text';

export function Avatar({
  name,
  color,
  src,
  size = 36,
  className,
}: {
  name: string;
  color?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        backgroundColor: color ?? 'rgb(var(--brand))',
        // White on some member colours is under AA; the initials take white
        // or black, whichever reads on this one.
        color: readableTextOn(color),
      }}
      aria-hidden={!name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
