import { Skeleton } from '@/components/ui/states';

// Instant skeleton for /guardian — stat row, status switcher, suggestions, comms feed.
export default function GuardianLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-surface/40 p-4">
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="mt-2 h-7 w-12" />
            <Skeleton className="mt-1 h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Status switcher */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-3">
        <Skeleton className="h-3 w-24" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-24 rounded-full" />)}
        </div>
      </div>

      {/* Suggestions panel */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>

      {/* Recent communications feed */}
      <div className="rounded-2xl border border-border bg-surface/40">
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-44" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2.5 w-48" />
              </div>
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
