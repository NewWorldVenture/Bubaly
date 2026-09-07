// Shared UI primitives, rendered from BOTH server and client components — 285
// files import this one module, which is why it can use neither translator:
// `getTranslations()` drags `next/headers` into the browser and fails the
// build, and `useTranslations()` is a hook a server component cannot run.
//
// Everything with words in it therefore lives in `states-client.tsx` and is
// re-exported from here, so no call site had to change. `EmptyState` is the one
// that stays: it takes an `icon` COMPONENT, and a component reference cannot
// cross a server→client boundary. Its words are all props, so it needs no
// translator of its own.
export {
  ErrorState,
  LoadingBlock,
  Skeleton,
  SkeletonCard,
  SkeletonList,
  SkeletonText,
  Spinner,
} from './states-client';

/** Empty state used across every module so blank lists never look broken. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      {Icon && (
        <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
          <Icon className="h-7 w-7" />
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
