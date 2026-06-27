import { Skeleton } from '@/components/ui/states';

// Instant skeleton for /wallet — mirrors the dashboard shape (header,
// family-total card with allocation bar, child cards, recent activity)
// so navigation feels immediate instead of frozen until the server responds.
export default function WalletLoading() {
  return (
    <div className="module-page" aria-busy="true">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>

      {/* Subnav */}
      <div className="mb-5 flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-20 rounded-lg" />)}
      </div>

      {/* Family total card */}
      <div className="mb-5 rounded-3xl border border-border bg-surface/40 p-6">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-9 w-44" />
        <Skeleton className="mt-4 h-2 w-full rounded-full" />
        <div className="mt-3 flex gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-3 w-20" />)}
        </div>
      </div>

      {/* Child cards */}
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-5 w-20" />
                </div>
              </div>
              <Skeleton className="h-7 w-14 rounded-lg" />
            </div>
            <Skeleton className="mt-3 h-2 w-full rounded-full" />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {Array.from({ length: 4 }).map((_, j) => <Skeleton key={j} className="h-12 rounded-xl" />)}
            </div>
          </div>
        ))}
      </div>

      {/* Recent activity */}
      <div className="mt-6 space-y-2">
        <Skeleton className="h-3 w-28" />
        <div className="overflow-hidden rounded-2xl border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-2.5 w-24" />
              </div>
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
