import Link from 'next/link';
import { cn } from '@/lib/utils/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

// A link that looks like a Button (A11Y-001).
//
// A Link with a Button as its child put a button inside a link. Interactive
// content inside <a> is invalid HTML; the keyboard met two tab stops for one
// action (the link, then the button inside it); and the button covered its own
// link, which axe reported as a 9px target on the 404 page at 390 px. This is
// the link itself, wearing Button's look.
//
// Button's class strings are copied, not imported: components/ui/button.tsx
// does not export them and is left as it is. tests/a-link-is-not-wrapped-
// around-a-button.test.ts holds these copies equal to Button's.
const BASE =
  'inline-flex select-none items-center justify-center rounded-xl font-medium transition active:scale-[0.98] focus-ring disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-[44px]';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-brand-fg hover:opacity-90 shadow-glow disabled:shadow-none',
  secondary: 'bg-elevated text-fg hover:bg-elevated/70 border border-border',
  outline: 'bg-transparent text-fg border border-border hover:bg-elevated',
  ghost: 'bg-transparent text-fg hover:bg-elevated',
  danger: 'bg-danger text-danger-fg hover:opacity-90',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 min-w-[2.25rem] px-3 text-sm gap-1.5',
  md: 'h-11 min-w-[2.75rem] px-5 text-sm gap-2',
  lg: 'h-[3.25rem] min-w-[3.25rem] px-7 text-base gap-2.5',
  icon: 'h-10 w-10 p-0 justify-center',
};

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
}
