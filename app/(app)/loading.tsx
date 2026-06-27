import { Skeleton, SkeletonList } from '@/components/ui/states';

// Route-level loading UI for the authenticated app. Next.js shows this instantly
// during navigation/data loads, so pages feel fast and never flash blank. It
// mirrors the common page rhythm (title + content cards) to avoid layout shift.
export default function AppLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <SkeletonList count={4} />
    </div>
  );
}
