import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand text-brand-fg hover:brightness-110 shadow-glow disabled:shadow-none',
  secondary: 'bg-elevated text-fg hover:bg-elevated/70 border border-border',
  outline: 'bg-transparent text-fg border border-border hover:bg-elevated',
  ghost: 'bg-transparent text-fg hover:bg-elevated',
  danger: 'bg-danger text-white hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 min-w-[2.25rem] px-3 text-sm gap-1.5',
  md: 'h-11 min-w-[2.75rem] px-5 text-sm gap-2',
  lg: 'h-[3.25rem] min-w-[3.25rem] px-7 text-base gap-2.5',
  icon: 'h-10 w-10 p-0 justify-center',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center rounded-2xl font-medium transition-all duration-200 active:scale-[0.98] focus-ring disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
