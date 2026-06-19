import { cn } from '@/lib/utils/cn';

type Tone = 'brand' | 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  brand: 'bg-brand/15 text-brand border-brand/25',
  neutral: 'bg-elevated text-muted border-border',
  success: 'bg-success/15 text-success border-success/25',
  warning: 'bg-warning/15 text-warning border-warning/25',
  danger: 'bg-danger/15 text-danger border-danger/25',
  accent: 'bg-accent/15 text-accent border-accent/25',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: { tone?: Tone } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
